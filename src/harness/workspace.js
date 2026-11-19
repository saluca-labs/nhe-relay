// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Isolated workspace per task (D21 item 6). Each agent task gets its own workspace: a fresh
// worktree or sandbox, never shared between tasks, cleaned on completion. A leftover workspace
// (created but not cleaned) may be reused only if it is provably the task own and has nothing
// unpushed. This is the program runner leftover rule.
//
// The relay stores nothing. The caller (the harness or the program runner) holds each sealed
// revision and its receipt. The relay seals and verifies: the workspace_id is derived from
// (entity_id, task_id) so two different tasks never share a workspace, the lifecycle is
// hash-chained so the sequence of create, reuse and clean events is tamper-evident, and the
// leftover reuse rule is enforced in code.
//
// Rules this module enforces in code:
//   1. workspace_id is deterministic: SHA-256 of entity_id + NUL + task_id. Two different
//      task_ids produce different workspace_ids. A workspace is never shared between tasks.
//   2. createWorkspace always starts a fresh chain (revision 0, status active). The caller
//      must not create a workspace for a task that already has an active one; reuseLeftover
//      is the path for that case.
//   3. cleanWorkspace transitions active to cleaned. A cleaned workspace cannot be cleaned
//      again, cannot be reused, and cannot transition back to active.
//   4. reuseLeftover refuses unless every condition is provably true:
//        a. The workspace receipt verifies under the relay key (provably the relay own).
//        b. The workspace entity_id matches the requesting identity (provably the task own).
//        c. The workspace task_id matches the requesting task (provably the task own).
//        d. unpushed_commits === 0 AND uncommitted_changes === false (nothing unpushed).
//        e. The workspace status is active (not already cleaned).
//      Unknown is a refusal, never a pass: if unpushed_commits or uncommitted_changes is
//      missing or the wrong type, the reuse is refused.
//
// Chain: root_0 = genesis(entity_id, "workspace/" + task_id) and
// root_n = nextRoot(root_{n-1}, event_n), the same hash chain as the turn log and the plan.
// Each revision carries its event, so verifyWorkspaceHistory() replays the whole history from
// genesis and checks every root, every digest, every receipt and every derived state.

import { sha256Hex, canonical, issueReceipt, checkReceipt, isRootHex, genesis, nextRoot } from "../chain.js";

const enc = new TextEncoder();

const WORKSPACE_KIND = "nhe-relay/workspace";
const RECEIPT_TOOL = "workspace";
const STATUS_ACTIVE = "active";
const STATUS_CLEANED = "cleaned";
const TASK_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ENTITY_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const PRINTABLE_RE = /^[\x20-\x7e]{1,512}$/;

const MAX_REVISIONS = 100;
const MAX_REPO_LEN = 512;
const MAX_BRANCH_LEN = 200;
const MAX_PATH_LEN = 512;

export class WorkspaceError extends Error {}

/**
 * Derive the workspace_id from (entity_id, task_id). Deterministic: the same pair always
 * produces the same id. Two different task_ids produce different ids, so a workspace is
 * never shared between tasks.
 * @param {string} entityId
 * @param {string} taskId
 * @returns {Promise<string>} 64-char lowercase hex
 */
export async function workspaceId(entityId, taskId) {
  return sha256Hex(enc.encode(entityId + "\u0000" + taskId));
}

function nonEmptyStr(v, max, what) {
  if (typeof v !== "string" || v.trim().length === 0) throw new WorkspaceError(what + " must be a non-empty string");
  if (v.length > max) throw new WorkspaceError(what + " must be at most " + max + " characters");
  return v;
}

function tsOf(ts) {
  if (typeof ts === "number" && Number.isSafeInteger(ts)) return ts;
  return Math.floor(Date.now() / 1000);
}

/**
 * Validate the common workspace fields. Returns normalised { taskId, entityId, employeeId,
 * repo, branch, path }.
 * @param {object} opts
 * @returns {object}
 */
export function validateWorkspaceFields(opts) {
  if (typeof opts !== "object" || opts === null || Array.isArray(opts))
    throw new WorkspaceError("workspace opts must be an object");

  const taskId = opts.task_id;
  if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId))
    throw new WorkspaceError("task_id must be 1-64 of A-Z a-z 0-9 . _ -");

  const entityId = opts.entity_id ?? opts.entityId;
  if (typeof entityId !== "string" || !ENTITY_ID_RE.test(entityId))
    throw new WorkspaceError("entity_id must be 2-48 of a-z 0-9 -");

  const employeeId = opts.employee_id ?? opts.employeeId;
  if (typeof employeeId !== "string" || !ENTITY_ID_RE.test(employeeId))
    throw new WorkspaceError("employee_id must be 2-48 of a-z 0-9 -");

  const repo = nonEmptyStr(opts.repo, MAX_REPO_LEN, "repo");
  const branch = nonEmptyStr(opts.branch, MAX_BRANCH_LEN, "branch");
  const path = nonEmptyStr(opts.path, MAX_PATH_LEN, "path");
  if (!PRINTABLE_RE.test(path)) throw new WorkspaceError("path must be printable ASCII");

  return { taskId, entityId, employeeId, repo, branch, path };
}

/**
 * Compute the digest of a workspace artifact body (everything except digest and receipt).
 * @param {object} body
 * @returns {Promise<string>}
 */
export async function workspaceDigest(body) {
  return sha256Hex(enc.encode(canonical({ kind: WORKSPACE_KIND, ...body })));
}

function receiptFields(plan) {
  return {
    entity_id: plan.entity_id,
    session_hash: plan.digest,
    tool: RECEIPT_TOOL,
    outcome: plan.status,
    ts: plan.ts
  };
}

function stateOf(plan) {
  return {
    workspace_id: plan.workspace_id,
    task_id: plan.task_id,
    entity_id: plan.entity_id,
    employee_id: plan.employee_id,
    repo: plan.repo,
    branch: plan.branch,
    path: plan.path,
    status: plan.status,
    revision: plan.revision
  };
}

/**
 * Seal a workspace revision: compute digest, root, and receipt.
 * @param {string} hmacKey
 * @param {object|null} prev - previous revision (or null for revision 0)
 * @param {object} state - the persistent state fields
 * @param {object} event - the lifecycle event
 * @returns {Promise<{plan: object, receipt: string}>}
 */
async function seal(hmacKey, prev, state, event) {
  const revision = prev ? prev.revision + 1 : 0;
  const prevDigest = prev ? prev.digest : null;
  const prevRoot = prev ? prev.root : await genesis(state.entity_id, "workspace/" + state.task_id);

  const body = {
    workspace_id: state.workspace_id,
    task_id: state.task_id,
    entity_id: state.entity_id,
    employee_id: state.employee_id,
    repo: state.repo,
    branch: state.branch,
    path: state.path,
    status: state.status,
    revision,
    prev_digest: prevDigest,
    root: await nextRoot(prevRoot, event),
    event,
    ts: event.ts
  };

  const digest = await workspaceDigest(body);
  const plan = { ...body, digest };
  const receipt = await issueReceipt(hmacKey, receiptFields(plan));
  return { plan, receipt };
}

/**
 * Verify a single sealed revision: digest, receipt, and that the status is valid.
 * @param {string} hmacKey
 * @param {object} plan
 * @param {string} receipt
 * @returns {Promise<boolean>}
 */
export async function verifyWorkspaceRevision(hmacKey, plan, receipt) {
  if (typeof plan !== "object" || plan === null) return false;
  if (!isRootHex(plan.digest) || !isRootHex(plan.root)) return false;
  if (plan.status !== STATUS_ACTIVE && plan.status !== STATUS_CLEANED) return false;
  const { digest, ...body } = plan;
  let expected;
  try {
    expected = await workspaceDigest(body);
  } catch {
    return false;
  }
  if (digest !== expected) return false;
  if (!(await checkReceipt(hmacKey, receiptFields(plan), receipt))) return false;
  return true;
}

/**
 * Require a valid sealed revision or throw.
 * @param {string} hmacKey
 * @param {object} plan
 * @param {string} receipt
 */
async function requireValid(hmacKey, plan, receipt) {
  if (typeof plan !== "object" || plan === null) throw new WorkspaceError("workspace revision is not an object");
  if (!(await verifyWorkspaceRevision(hmacKey, plan, receipt)))
    throw new WorkspaceError("workspace revision does not verify: digest or receipt mismatch");
}

/**
 * Create a fresh workspace for a task (revision 0, status active). The workspace_id is
 * derived from (entity_id, task_id) and is unique per task. The caller must not call this
 * for a task that already has an active workspace; reuseLeftover is the path for that case.
 *
 * @param {string} hmacKey
 * @param {object} opts - { employee_id, entity_id, task_id, repo, branch, path, ts }
 * @returns {Promise<{plan: object, receipt: string}>}
 */
export async function createWorkspace(hmacKey, opts) {
  const f = validateWorkspaceFields(opts);
  const wid = await workspaceId(f.entityId, f.taskId);
  const state = {
    workspace_id: wid,
    task_id: f.taskId,
    entity_id: f.entityId,
    employee_id: f.employeeId,
    repo: f.repo,
    branch: f.branch,
    path: f.path,
    status: STATUS_ACTIVE
  };
  const event = { type: "created", by: f.entityId, ts: tsOf(opts.ts) };
  return seal(hmacKey, null, state, event);
}

/**
 * Reuse a leftover workspace. Refuses unless the workspace is provably the task own
 * (receipt verifies, entity_id and task_id match) and nothing is unpushed
 * (unpushed_commits === 0 AND uncommitted_changes === false). Unknown is a refusal.
 *
 * @param {string} hmacKey
 * @param {object} plan - the current sealed workspace revision
 * @param {string} receipt - the receipt for the current revision
 * @param {object} opts - { entity_id, task_id, unpushed_commits, uncommitted_changes, ts }
 * @returns {Promise<{plan: object, receipt: string}>}
 */
export async function reuseLeftover(hmacKey, plan, receipt, opts) {
  await requireValid(hmacKey, plan, receipt);

  // b. Provably the task own: entity_id matches.
  if (plan.entity_id !== opts.entity_id)
    throw new WorkspaceError("workspace belongs to another entity");

  // c. Provably the task own: task_id matches.
  if (plan.task_id !== opts.task_id)
    throw new WorkspaceError("workspace belongs to another task");

  // e. Workspace must be active (not cleaned).
  if (plan.status !== STATUS_ACTIVE)
    throw new WorkspaceError("workspace is not active: already cleaned");

  // d. Nothing unpushed. Cannot tell is never a pass.
  if (typeof opts.unpushed_commits !== "number" || !Number.isSafeInteger(opts.unpushed_commits) || opts.unpushed_commits < 0)
    throw new WorkspaceError("unpushed_commits must be a non-negative integer");
  if (opts.unpushed_commits > 0)
    throw new WorkspaceError("workspace has " + opts.unpushed_commits + " unpushed commits");

  if (typeof opts.uncommitted_changes !== "boolean")
    throw new WorkspaceError("uncommitted_changes must be a boolean");
  if (opts.uncommitted_changes !== false)
    throw new WorkspaceError("workspace has uncommitted changes");

  const event = {
    type: "reused",
    by: opts.entity_id,
    unpushed_commits: opts.unpushed_commits,
    uncommitted_changes: opts.uncommitted_changes,
    ts: tsOf(opts.ts)
  };
  return seal(hmacKey, plan, stateOf(plan), event);
}

/**
 * Clean a workspace on completion (transition active to cleaned). Requires a valid receipt
 * and the requesting identity must match. A cleaned workspace cannot be cleaned again.
 *
 * @param {string} hmacKey
 * @param {object} plan - the current sealed workspace revision
 * @param {string} receipt - the receipt for the current revision
 * @param {object} opts - { entity_id, ts }
 * @returns {Promise<{plan: object, receipt: string}>}
 */
export async function cleanWorkspace(hmacKey, plan, receipt, opts) {
  await requireValid(hmacKey, plan, receipt);

  if (plan.entity_id !== opts.entity_id)
    throw new WorkspaceError("workspace belongs to another entity");

  if (plan.status !== STATUS_ACTIVE)
    throw new WorkspaceError("workspace is already cleaned");

  const state = { ...stateOf(plan), status: STATUS_CLEANED };
  const event = { type: "cleaned", by: opts.entity_id, ts: tsOf(opts.ts) };
  return seal(hmacKey, plan, state, event);
}

/**
 * Verify a whole workspace history from genesis: each revision verifies on its own,
 * revisions are consecutive, prev_digest links, every root recomputes, and the workspace_id
 * is consistent across all revisions.
 *
 * @param {string} hmacKey
 * @param {Array<{plan: object, receipt: string}>} revisions
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function verifyWorkspaceHistory(hmacKey, revisions) {
  if (!Array.isArray(revisions) || revisions.length === 0) return { ok: false, reason: "empty_history" };
  if (revisions.length > MAX_REVISIONS) return { ok: false, reason: "too_many_revisions" };

  const first = revisions[0].plan;
  if (typeof first !== "object" || first === null) return { ok: false, reason: "bad_revision" };
  const ids = {
    task_id: first.task_id,
    entity_id: first.entity_id,
    employee_id: first.employee_id,
    workspace_id: first.workspace_id
  };

  let prevRoot = await genesis(ids.entity_id, "workspace/" + ids.task_id);
  let prevDigest = null;

  for (let i = 0; i < revisions.length; i++) {
    const { plan, receipt } = revisions[i];
    if (!(await verifyWorkspaceRevision(hmacKey, plan, receipt)))
      return { ok: false, reason: "revision_" + i + "_does_not_verify" };
    if (plan.task_id !== ids.task_id || plan.entity_id !== ids.entity_id || plan.employee_id !== ids.employee_id)
      return { ok: false, reason: "revision_" + i + "_identity_changed" };
    if (plan.workspace_id !== ids.workspace_id)
      return { ok: false, reason: "revision_" + i + "_workspace_id_changed" };
    if (plan.revision !== i) return { ok: false, reason: "revision_" + i + "_out_of_order" };
    if (plan.prev_digest !== prevDigest) return { ok: false, reason: "revision_" + i + "_prev_digest" };
    if (plan.root !== (await nextRoot(prevRoot, plan.event)))
      return { ok: false, reason: "revision_" + i + "_root" };
    if (plan.ts !== plan.event.ts) return { ok: false, reason: "revision_" + i + "_ts" };
    prevRoot = plan.root;
    prevDigest = plan.digest;
  }
  return { ok: true };
}