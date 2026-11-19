# T3.05 - Task walkthrough (D21 item 1)

Every agent task ends with a walkthrough artifact: a summary, evidence (files touched,
command output, turn receipt links), and an outcome. The artifact is hashed into the
turn chain with an HMAC receipt so its integrity is independently verifiable.

## Core invariant

A task with no evidence is marked "no_evidence" and is never reported as done.

- `computeOutcome()` forces `"no_evidence"` when the evidence block is empty, regardless
  of what the caller requested.
- `isDone("no_evidence")` returns `false`. `isDone()` returns `true` only for `"done"`.
- `verifyWalkthrough()` rejects an artifact whose outcome is `"done"` but whose evidence
  is empty (the no-evidence invariant check).

## Artifact structure

```json
{
  "task_id": "T3.05",
  "entity_id": "agent-emp-001",
  "employee_id": "emp-001",
  "summary": "Implemented walkthrough mechanism",
  "evidence": {
    "files_touched": ["src/harness/walkthrough.js"],
    "command_output": "node --test 355 pass",
    "turn_receipts": ["a1b2..."]
  },
  "outcome": "done",
  "ts": 1700000000,
  "digest": "abcdef..."
}
```

- `digest` is `SHA-256(canonical({kind: "nhe-relay/walkthrough", ...body}))` where `body`
  is the artifact without the `digest` and `receipt` fields. Canonical is RFC 8785 JCS.
- `receipt` is an HMAC-SHA-256 over the digest, entity id, tool name, outcome and timestamp,
  issued with the relay's `RELAY_HMAC_KEY`.

## MCP tool

`soul.walkthrough` is exposed in the relay's MCP tool catalog. An authenticated harness
calls it via `tools/call` to submit a walkthrough at the end of a task. The relay handles
it locally (it is not forwarded to soul-svc) because the walkthrough is about the relay's
own chain, not the soul backend.

The tool accepts: `task_id`, `summary`, `files_touched`, `command_output`,
`turn_receipts`, `requested_outcome`. It returns the sealed artifact with its digest and
receipt in `structuredContent`.

## Verification

`verifyWalkthrough(hmacKey, artifact, receipt)` checks:
1. The digest matches a fresh hash of the artifact body (minus digest and receipt).
2. The receipt verifies under the same HMAC key.
3. The outcome is consistent with the evidence (no-evidence invariant).

## Planted faults (demonstrated RED then GREEN)

- **F1**: `computeOutcome` returns the requested outcome even when evidence is empty.
  7 tests RED. The no-evidence invariant is broken.
- **F2**: `isDone` returns true for `"no_evidence"`. 4 tests RED. The core invariant
  is broken.
- **F3**: `walkthroughDigest` includes a circular digest field. 1 test RED. The digest
  no longer reflects the body content.
- **F4**: `verifyWalkthrough` skips the no-evidence invariant check. 1 test RED. An
  artifact with empty evidence but outcome `"done"` passes verification.
- **F5**: `validateWalkthrough` accepts an empty summary. 2 tests RED. Missing required
  field is not enforced.
