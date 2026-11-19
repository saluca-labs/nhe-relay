// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Commentable plans (D21 item 2). Before work starts, the agent posts a plan: a summary and
// a list of steps. The employee comments inline (anchored to a step, optionally to a line of
// that step). Every comment, every agent revision and the employee's Proceed is an event in
// the plan's own hash chain, so each one is a new sealed plan revision.
//
// Rules this module enforces in code:
//   1. Every step names an action. The action decides whether the step is gated. An action
//      that is not on either list is refused (unknown is a refusal, never a default).
//   2. The agent may mark an ungated step as gated (narrowing). It may never mark a gated
//      action as ungated (widening).
//   3. The plan lists up front, from revision 0, which steps will become proposals: every
//      gated step, one decision card each (proposalCards()).
//   4. Comments and Proceed come from the plan's employee; posting and revising come from
//      the plan's agent entity. An event from the wrong party is refused.
//   5. Proceed names the digest of the revision the employee saw. A stale Proceed (the plan
//      changed after they looked) is refused, and so is a Proceed while a comment is still
//      unanswered by a revision.
//   6. Proceed releases only ungated steps. A gated step is never released by Proceed; it
//      stays a proposal that needs its own card.
//
// Chain: root_0 = nextRoot(genesis(entity_id, "plan/" + task_id), event_0) and
// root_n = nextRoot(root_{n-1}, event_n), using the same hash chain as the turn log.
// Each revision carries its event, so verifyPlanHistory() replays the whole history from
// genesis and checks every root, every digest, every receipt and every derived state.
//
// The relay stores nothing. The caller keeps each sealed revision and its receipt. The MCP
// catalog exposes only the agent side (post and revise). Comment and Proceed are called by
// the approval surface (D8) after it has authenticated the employee; they are deliberately
// not harness tools, so an agent cannot comment on or proceed its own plan.

import { sha256Hex, canonical, issueReceipt, checkReceipt, isRootHex, genesis, nextRoot } from "../chain.js";

const enc = new TextEncoder();

const PLAN_KIND = "nhe-relay/plan";
const RECEIPT_TOOL = "plan";

/** Actions that stay inside the task's own workspace and can be undone. Proceed releases these. */
export const UNGATED_ACTIONS = Object.freeze(["read", "search", "analyze", "edit", "test", "draft"]);

/** Actions that reach a recipient, the public or the record. Each becomes a proposal (a card). */
export const GATED_ACTIONS = Object.freeze([
  "send", "publish", "schedule", "deploy", "push", "merge", "delete", "pay", "file", "submit",
  "external_write", "queued_action"
]);

const STATUS_REVIEW = "awaiting_review";
const STATUS_PROCEEDED = "proceeded";
const EMPLOYEE_EVENTS = new Set(["comment", "proceeded"]);
const STEP_FIELDS = new Set(["id", "text", "action", "gated"]);
const STEP_ID = /^[A-Za-z0-9_-]{1,32}$/;
const TASK_ID = /^[A-Za-z0-9._-]{1,64}$/;

const MAX_STEPS = 50;
const MAX_STEP_TEXT = 1024;
const MAX_SUMMARY = 4096;
const MAX_COMMENT_TEXT = 2048;
const MAX_COMMENTS = 200;
const MAX_REVISIONS = 100;

export class PlanError extends Error {}

/**
 * Is this action gated? Throws on an action that is on neither list.
 * @param {unknown} action
 * @returns {boolean}
 */
export function classifyAction(action) {
  if (typeof action !== "string") throw new PlanError("step action must be a string");
  if (UNGATED_ACTIONS.includes(action)) return false;
  if (GATED_ACTIONS.includes(action)) return true;
  throw new PlanError(`unmapped step action: ${action}`);
}

function nonEmpty(v, max, what) {
  if (typeof v !== "string" || v.trim().length === 0) throw new PlanError(`${what} must be a non-empty string`);
  if (v.length > max) throw new PlanError(`${what} must be at most ${max} characters`);
  return v;
}

/**
 * Validate and normalise a step list. Each step becomes { id, text, action, gated }.
 * @param {unknown} steps
 * @returns {Array<{id: string, text: string, action: string, gated: boolean}>}
 */
export function normaliseSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new PlanError("a plan needs at least one step");
  if (steps.length > MAX_STEPS) throw new PlanError(`a plan has at most ${MAX_STEPS} steps`);
  const seen = new Set();
  const out = [];
  for (const s of steps) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) throw new PlanError("each step must be an object");
    for (const k of Object.keys(s)) if (!STEP_FIELDS.has(k)) throw new PlanError(`unknown step field: ${k}`);
    if (typeof s.id !== "string" || !STEP_ID.test(s.id)) throw new PlanError("step id must be 1-32 of A-Z a-z 0-9 _ -");
    if (seen.has(s.id)) throw new PlanError(`duplicate step id: ${s.id}`);
    seen.add(s.id);
    const text = nonEmpty(s.text, MAX_STEP_TEXT, `step ${s.id} text`);
    const actionGated = classifyAction(s.action);
    if (s.gated !== undefined && typeof s.gated !== "boolean") throw new PlanError(`step ${s.id}: gated must be a boolean`);
    if (actionGated && s.gated === false) throw new PlanError(`step ${s.id}: a ${s.action} step is gated and cannot be marked ungated`);
    const gated = s.gated === undefined ? actionGated : s.gated;
    out.push({ id: s.id, text, action: s.action, gated });
  }
  return out;
}

/**
 * The step ids that will become proposals: every gated step, in plan order.
 * @param {Array<{id: string, gated: boolean}>} steps
 * @returns {string[]}
 */
export function proposalsOf(steps) {
  return steps.filter((s) => s.gated).map((s) => s.id);
}

function stateOf(plan) {
  return {
    summary: plan.summary,
    steps: plan.steps,
    proposals: plan.proposals,
    comments: plan.comments,
    open_comments: plan.open_comments,
    status: plan.status
  };
}

/**
 * Apply one event to a plan state. Pure: returns the next state or throws. Used both to build
 * a revision and to replay a history during verification, so the two can never disagree.
 * @param {object|null} state - the previous state, or null before the plan is posted
 * @param {object} event
 * @param {{entity_id: string, employee_id: string, prevDigest: string|null}} ctx
 */
export function applyEvent(state, event, ctx) {
  if (typeof event !== "object" || event === null) throw new PlanError("event must be an object");
  const fromEmployee = EMPLOYEE_EVENTS.has(event.type);
  const expectedBy = fromEmployee ? ctx.employee_id : ctx.entity_id;
  if (event.by !== expectedBy) throw new PlanError(`${event.type} must come from ${fromEmployee ? "the plan's employee" : "the plan's agent"}`);
  if (!Number.isSafeInteger(event.ts)) throw new PlanError("event ts must be an integer");

  if (event.type === "posted") {
    if (state !== null) throw new PlanError("a plan is posted once");
    const steps = normaliseSteps(event.steps);
    return {
      summary: nonEmpty(event.summary, MAX_SUMMARY, "summary"),
      steps,
      proposals: proposalsOf(steps),
      comments: [],
      open_comments: [],
      status: STATUS_REVIEW
    };
  }

  if (state === null) throw new PlanError("the plan must be posted first");
  if (state.status !== STATUS_REVIEW) throw new PlanError("the plan has already proceeded; post a new plan to change it");

  if (event.type === "comment") {
    if (state.comments.length >= MAX_COMMENTS) throw new PlanError(`a plan has at most ${MAX_COMMENTS} comments`);
    const step = state.steps.find((s) => s.id === event.step_id);
    if (!step) throw new PlanError(`comment anchored to unknown step: ${event.step_id}`);
    if (event.line !== null) {
      const lines = step.text.split("\n").length;
      if (!Number.isSafeInteger(event.line) || event.line < 1 || event.line > lines)
        throw new PlanError(`comment line must be 1-${lines} for step ${step.id}, or null`);
    }
    const id = `c${state.comments.length + 1}`;
    if (event.id !== id) throw new PlanError(`comment id must be ${id}`);
    const comment = {
      id,
      step_id: step.id,
      line: event.line,
      text: nonEmpty(event.text, MAX_COMMENT_TEXT, "comment text"),
      by: event.by,
      ts: event.ts
    };
    return { ...state, comments: [...state.comments, comment], open_comments: [...state.open_comments, id] };
  }

  if (event.type === "revised") {
    if (!Array.isArray(event.answers)) throw new PlanError("answers must be an array of comment ids");
    const answered = new Set();
    for (const a of event.answers) {
      if (!state.open_comments.includes(a)) throw new PlanError(`answers names a comment that is not open: ${a}`);
      if (answered.has(a)) throw new PlanError(`answers names a comment twice: ${a}`);
      answered.add(a);
    }
    const steps = normaliseSteps(event.steps);
    return {
      ...state,
      summary: nonEmpty(event.summary, MAX_SUMMARY, "summary"),
      steps,
      proposals: proposalsOf(steps),
      open_comments: state.open_comments.filter((c) => !answered.has(c))
    };
  }

  if (event.type === "proceeded") {
    if (state.open_comments.length > 0) throw new PlanError(`cannot proceed: comments not yet answered by a revision: ${state.open_comments.join(", ")}`);
    if (event.seen_digest !== ctx.prevDigest) throw new PlanError("stale proceed: the plan changed after the revision you saw");
    return { ...state, status: STATUS_PROCEEDED };
  }

  throw new PlanError(`unknown plan event: ${event.type}`);
}

/**
 * Digest of a plan revision: SHA-256 over the canonical body (everything except digest).
 * @param {object} body
 * @returns {Promise<string>}
 */
export async function planDigest(body) {
  return sha256Hex(enc.encode(canonical({ kind: PLAN_KIND, ...body })));
}

function receiptFields(plan) {
  return { entity_id: plan.entity_id, session_hash: plan.digest, tool: RECEIPT_TOOL, outcome: plan.status, ts: plan.ts };
}

function tsOf(ts) {
  return Number.isSafeInteger(ts) ? ts : Math.floor(Date.now() / 1000);
}

async function seal(hmacKey, prev, ids, event) {
  const ctx = { entity_id: ids.entity_id, employee_id: ids.employee_id, prevDigest: prev ? prev.digest : null };
  const state = applyEvent(prev ? stateOf(prev) : null, event, ctx);
  const revision = prev ? prev.revision + 1 : 0;
  if (revision >= MAX_REVISIONS) throw new PlanError(`a plan has at most ${MAX_REVISIONS} revisions`);
  const prevRoot = prev ? prev.root : await genesis(ids.entity_id, "plan/" + ids.task_id);
  const root = await nextRoot(prevRoot, event);
  const body = {
    task_id: ids.task_id,
    entity_id: ids.entity_id,
    employee_id: ids.employee_id,
    revision,
    prev_digest: prev ? prev.digest : null,
    root,
    event,
    ...state,
    ts: event.ts
  };
  const digest = await planDigest(body);
  const plan = { ...body, digest };
  const receipt = await issueReceipt(hmacKey, receiptFields(plan));
  return { plan, receipt };
}

async function requireValid(hmacKey, plan, receipt) {
  if (!(await verifyPlanRevision(hmacKey, plan, receipt))) throw new PlanError("plan revision or receipt does not verify");
}

/**
 * The agent posts a plan before work starts (revision 0, awaiting review).
 * @param {string} hmacKey
 * @param {{employeeId: string, entityId: string, task_id: string, summary: string, steps: object[], ts?: number}} opts
 */
export async function createPlan(hmacKey, opts) {
  if (typeof opts !== "object" || opts === null) throw new PlanError("plan options must be an object");
  if (typeof opts.task_id !== "string" || !TASK_ID.test(opts.task_id)) throw new PlanError("task_id must be 1-64 of A-Z a-z 0-9 . _ -");
  if (typeof opts.entityId !== "string" || opts.entityId.length === 0) throw new PlanError("entityId is required");
  if (typeof opts.employeeId !== "string" || opts.employeeId.length === 0) throw new PlanError("employeeId is required");
  const steps = normaliseSteps(opts.steps);
  const event = { type: "posted", by: opts.entityId, summary: opts.summary, steps, ts: tsOf(opts.ts) };
  return seal(hmacKey, null, { task_id: opts.task_id, entity_id: opts.entityId, employee_id: opts.employeeId }, event);
}

/**
 * The employee comments inline on a step (and optionally a line of it). Called by the
 * approval surface after it authenticated the employee. Produces a new revision.
 * @param {string} hmacKey
 * @param {object} plan - the current sealed revision
 * @param {string} receipt
 * @param {{employeeId: string, step_id: string, line?: number|null, text: string, ts?: number}} opts
 */
export async function commentOnPlan(hmacKey, plan, receipt, opts) {
  await requireValid(hmacKey, plan, receipt);
  const event = {
    type: "comment",
    by: opts.employeeId,
    id: `c${plan.comments.length + 1}`,
    step_id: opts.step_id,
    line: opts.line === undefined ? null : opts.line,
    text: opts.text,
    ts: tsOf(opts.ts)
  };
  return seal(hmacKey, plan, plan, event);
}

/**
 * The agent revises the plan, answering open comments. Summary and steps default to the
 * current ones (an answer that changes nothing is still a revision in the chain).
 * @param {string} hmacKey
 * @param {object} plan
 * @param {string} receipt
 * @param {{entityId: string, summary?: string, steps?: object[], answers?: string[], ts?: number}} opts
 */
export async function revisePlan(hmacKey, plan, receipt, opts) {
  await requireValid(hmacKey, plan, receipt);
  const event = {
    type: "revised",
    by: opts.entityId,
    summary: opts.summary === undefined ? plan.summary : opts.summary,
    steps: normaliseSteps(opts.steps === undefined ? plan.steps : opts.steps),
    answers: opts.answers === undefined ? [] : opts.answers,
    ts: tsOf(opts.ts)
  };
  return seal(hmacKey, plan, plan, event);
}

/**
 * The employee presses Proceed on the revision they saw. Returns the sealed proceeded
 * revision and the release: the ungated steps that may now run, and the gated steps that
 * remain proposals (a card each).
 * @param {string} hmacKey
 * @param {object} plan
 * @param {string} receipt
 * @param {{employeeId: string, seen_digest: string, ts?: number}} opts
 */
export async function proceedPlan(hmacKey, plan, receipt, opts) {
  await requireValid(hmacKey, plan, receipt);
  const event = { type: "proceeded", by: opts.employeeId, seen_digest: opts.seen_digest, ts: tsOf(opts.ts) };
  const sealed = await seal(hmacKey, plan, plan, event);
  return { ...sealed, release: { released: releasedSteps(sealed.plan), proposals: proposalCards(sealed.plan) } };
}

/**
 * The step ids Proceed released. Empty until the plan has proceeded; never a gated step.
 * @param {object} plan
 * @returns {string[]}
 */
export function releasedSteps(plan) {
  if (plan?.status !== STATUS_PROCEEDED || !Array.isArray(plan.steps)) return [];
  return plan.steps.filter((s) => s.gated === false).map((s) => s.id);
}

/**
 * May the agent run this step now? Only an ungated step of a proceeded plan.
 * @param {object} plan
 * @param {string} stepId
 */
export function mayExecute(plan, stepId) {
  return releasedSteps(plan).includes(stepId);
}

/**
 * One proposal (decision card stub) per gated step, listed from revision 0 so the employee
 * sees up front which steps still need a card. The card binds to the plan digest.
 * @param {object} plan
 */
export function proposalCards(plan) {
  return plan.steps
    .filter((s) => plan.proposals.includes(s.id))
    .map((s) => ({ task_id: plan.task_id, step_id: s.id, action: s.action, text: s.text, plan_digest: plan.digest }));
}

/**
 * Verify one sealed revision on its own: digest, receipt, and that the listed proposals are
 * exactly the gated steps under the action rules.
 * @param {string} hmacKey
 * @param {object} plan
 * @param {string} receipt
 * @returns {Promise<boolean>}
 */
export async function verifyPlanRevision(hmacKey, plan, receipt) {
  if (typeof plan !== "object" || plan === null) return false;
  if (!isRootHex(plan.digest) || !isRootHex(plan.root)) return false;
  if (plan.status !== STATUS_REVIEW && plan.status !== STATUS_PROCEEDED) return false;
  const { digest, ...body } = plan;
  let expected;
  try {
    expected = await planDigest(body);
  } catch {
    return false;
  }
  if (digest !== expected) return false;
  if (!(await checkReceipt(hmacKey, receiptFields(plan), receipt))) return false;
  let steps;
  try {
    steps = normaliseSteps(plan.steps);
  } catch {
    return false;
  }
  if (canonical(steps) !== canonical(plan.steps)) return false;
  if (canonical(proposalsOf(steps)) !== canonical(plan.proposals)) return false;
  return true;
}

/**
 * Verify a whole plan history from genesis: each revision verifies on its own, revisions are
 * consecutive, prev_digest links, every root recomputes from the previous root and the event,
 * and every state equals the replay of the events.
 * @param {string} hmacKey
 * @param {Array<{plan: object, receipt: string}>} revisions
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function verifyPlanHistory(hmacKey, revisions) {
  if (!Array.isArray(revisions) || revisions.length === 0) return { ok: false, reason: "empty_history" };
  const first = revisions[0].plan;
  if (typeof first !== "object" || first === null) return { ok: false, reason: "bad_revision" };
  const ids = { task_id: first.task_id, entity_id: first.entity_id, employee_id: first.employee_id };
  let prevRoot = await genesis(ids.entity_id, "plan/" + ids.task_id);
  let prevDigest = null;
  let state = null;
  for (let i = 0; i < revisions.length; i++) {
    const { plan, receipt } = revisions[i];
    if (!(await verifyPlanRevision(hmacKey, plan, receipt))) return { ok: false, reason: `revision_${i}_does_not_verify` };
    if (plan.task_id !== ids.task_id || plan.entity_id !== ids.entity_id || plan.employee_id !== ids.employee_id)
      return { ok: false, reason: `revision_${i}_identity_changed` };
    if (plan.revision !== i) return { ok: false, reason: `revision_${i}_out_of_order` };
    if (plan.prev_digest !== prevDigest) return { ok: false, reason: `revision_${i}_prev_digest` };
    if (plan.root !== (await nextRoot(prevRoot, plan.event))) return { ok: false, reason: `revision_${i}_root` };
    try {
      state = applyEvent(state, plan.event, { ...ids, prevDigest });
    } catch (e) {
      return { ok: false, reason: `revision_${i}_event_refused: ${e instanceof Error ? e.message : "unknown"}` };
    }
    if (canonical(state) !== canonical(stateOf(plan))) return { ok: false, reason: `revision_${i}_state` };
    if (plan.ts !== plan.event.ts) return { ok: false, reason: `revision_${i}_ts` };
    prevRoot = plan.root;
    prevDigest = plan.digest;
  }
  return { ok: true };
}
