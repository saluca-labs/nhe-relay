// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Task walkthrough (D21 item 1). Every agent task ends with a walkthrough artifact: a
// summary, evidence (files touched, command output, links to turn receipts), and an
// outcome. The artifact is hashed into the turn chain with an HMAC receipt so its
// integrity is independently verifiable.
//
// The core invariant: a task with no evidence is marked "no_evidence" and is never
// reported as done. isDone() returns false for "no_evidence" outcomes, and
// createWalkthrough() forces outcome to "no_evidence" when the evidence block is empty,
// regardless of what the caller asked for.
//
// The walkthrough is NOT stored by the relay (the relay stores nothing). The caller
// (the harness, or the program runner) receives the sealed artifact and keeps it. The
// receipt lets any party verify that the artifact was issued by this relay under this
// key, and the digest lets any party verify that the artifact has not been tampered
// with since.

import { sha256Hex, canonical, issueReceipt, checkReceipt, isRootHex } from "../chain.js";

const enc = new TextEncoder();

const WALKTHROUGH_KIND = "nhe-relay/walkthrough";
const VALID_OUTCOMES = new Set(["done", "blocked", "no_evidence"]);

/**
 * Determine whether an evidence block is empty. Evidence is empty when it has no files
 * touched, no command output, and no turn receipts.
 * @param {object} evidence
 * @returns {boolean}
 */
export function evidenceIsEmpty(evidence) {
  if (!evidence || typeof evidence !== "object") return true;
  const files = Array.isArray(evidence.files_touched) ? evidence.files_touched : [];
  const output = typeof evidence.command_output === "string" ? evidence.command_output.trim() : "";
  const receipts = Array.isArray(evidence.turn_receipts) ? evidence.turn_receipts : [];
  return files.length === 0 && output.length === 0 && receipts.length === 0;
}

/**
 * Validate the walkthrough input fields. Throws on any validation failure.
 * @param {object} fields - { task_id, summary, files_touched, command_output, turn_receipts, requested_outcome }
 * @returns {object} normalised fields
 */
export function validateWalkthrough(fields) {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields))
    throw new Error("walkthrough fields must be an object");

  const taskId = fields.task_id;
  if (typeof taskId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(taskId))
    throw new Error("task_id must be a non-empty string (alphanumeric, dot, hyphen, underscore)");

  const summary = fields.summary;
  if (typeof summary !== "string" || summary.trim().length === 0)
    throw new Error("summary must be a non-empty string");
  if (summary.length > 4096)
    throw new Error("summary must be at most 4096 characters");

  const filesTouched = Array.isArray(fields.files_touched)
    ? fields.files_touched.filter(f => typeof f === "string" && f.length > 0)
    : [];
  if (filesTouched.length > 200)
    throw new Error("files_touched must have at most 200 entries");

  const commandOutput = typeof fields.command_output === "string" ? fields.command_output : "";
  if (commandOutput.length > 16384)
    throw new Error("command_output must be at most 16384 characters");

  const turnReceipts = Array.isArray(fields.turn_receipts)
    ? fields.turn_receipts.filter(r => typeof r === "string" && /^[0-9a-f]{64}$/.test(r))
    : [];
  if (turnReceipts.length > 100)
    throw new Error("turn_receipts must have at most 100 entries");

  const requestedOutcome = typeof fields.requested_outcome === "string" ? fields.requested_outcome : "done";
  if (!VALID_OUTCOMES.has(requestedOutcome))
    throw new Error("requested_outcome must be one of: done, blocked, no_evidence");

  return { taskId, summary, filesTouched, commandOutput, turnReceipts, requestedOutcome };
}

/**
 * Compute the outcome. If the evidence is empty, the outcome is always "no_evidence",
 * no matter what the caller requested. This is the core invariant: a task with no
 * evidence is never reported as done.
 * @param {object} evidence - { files_touched, command_output, turn_receipts }
 * @param {string} requestedOutcome
 * @returns {string} "done" | "blocked" | "no_evidence"
 */
export function computeOutcome(evidence, requestedOutcome) {
  if (evidenceIsEmpty(evidence)) return "no_evidence";
  return requestedOutcome;
}

/**
 * Check whether a walkthrough outcome means the task is done. Returns false for
 * "no_evidence" and "blocked". Returns true only for "done".
 * @param {string} outcome
 * @returns {boolean}
 */
export function isDone(outcome) {
  return outcome === "done";
}

/**
 * Check whether a walkthrough is marked as having no evidence.
 * @param {string} outcome
 * @returns {boolean}
 */
export function isNoEvidence(outcome) {
  return outcome === "no_evidence";
}

/**
 * Compute the digest of a walkthrough artifact. The digest covers the canonical JSON of
 * the artifact body (everything except the digest and receipt fields), so the digest is
 * a tamper-evident fingerprint of the walkthrough content.
 * @param {object} body - the artifact body without digest and receipt
 * @returns {Promise<string>} 64-char lowercase hex digest
 */
export async function walkthroughDigest(body) {
  return sha256Hex(enc.encode(canonical({ kind: WALKTHROUGH_KIND, ...body })));
}

/**
 * Create a sealed walkthrough artifact. The artifact includes the summary, evidence,
 * outcome, and a digest over its own content. The receipt is an HMAC over the digest
 * and the entity/session identity, tying the walkthrough to the relay key.
 *
 * @param {string} hmacKey - the relay HMAC key
 * @param {object} opts - { employeeId, entityId, task_id, summary, files_touched, command_output, turn_receipts, requested_outcome, ts }
 * @returns {Promise<{artifact: object, receipt: string}>}
 */
export async function createWalkthrough(hmacKey, opts) {
  const validated = validateWalkthrough(opts);

  const evidence = {
    files_touched: validated.filesTouched,
    command_output: validated.commandOutput,
    turn_receipts: validated.turnReceipts
  };

  const outcome = computeOutcome(evidence, validated.requestedOutcome);

  const ts = typeof opts.ts === "number" && Number.isSafeInteger(opts.ts)
    ? opts.ts
    : Math.floor(Date.now() / 1000);

  const body = {
    task_id: validated.taskId,
    entity_id: opts.entityId,
    employee_id: opts.employeeId,
    summary: validated.summary,
    evidence,
    outcome,
    ts
  };

  const digest = await walkthroughDigest(body);

  const artifact = { ...body, digest };

  const receipt = await issueReceipt(hmacKey, {
    entity_id: opts.entityId,
    session_hash: digest,
    tool: "walkthrough",
    outcome,
    ts
  });

  return { artifact, receipt };
}

/**
 * Verify a walkthrough artifact and its receipt.
 *
 * Checks:
 * 1. The digest matches a fresh hash of the artifact body (minus digest and receipt).
 * 2. The receipt verifies under the same HMAC key.
 * 3. The outcome is consistent with the evidence (no-evidence invariant).
 *
 * @param {string} hmacKey
 * @param {object} artifact - the sealed walkthrough artifact
 * @param {string} receipt - the HMAC receipt
 * @returns {Promise<boolean>}
 */
export async function verifyWalkthrough(hmacKey, artifact, receipt) {
  if (typeof artifact !== "object" || artifact === null) return false;
  if (typeof artifact.digest !== "string" || !isRootHex(artifact.digest)) return false;
  if (typeof artifact.outcome !== "string" || !VALID_OUTCOMES.has(artifact.outcome)) return false;

  const { digest: _d, ...body } = artifact;
  void _d;

  // 1. Recompute the digest over the body (without the digest field).
  const expectedDigest = await walkthroughDigest(body);
  if (artifact.digest !== expectedDigest) return false;

  // 2. Verify the receipt.
  const receiptOk = await checkReceipt(hmacKey, {
    entity_id: artifact.entity_id,
    session_hash: artifact.digest,
    tool: "walkthrough",
    outcome: artifact.outcome,
    ts: artifact.ts
  }, receipt);
  if (!receiptOk) return false;

  // 3. Enforce the no-evidence invariant: if evidence is empty, outcome must be no_evidence.
  const expectedOutcome = computeOutcome(artifact.evidence, artifact.outcome === "no_evidence" ? "no_evidence" : artifact.outcome);
  if (artifact.outcome !== expectedOutcome) return false;

  return true;
}
