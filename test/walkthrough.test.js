// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// T3.05 - Task walkthrough (D21 item 1).
// Every agent task ends with a walkthrough artifact: summary, evidence (files touched,
// command output, turn receipt links), hashed into the turn chain with an HMAC receipt.
// A task with no evidence is marked "no_evidence" and is never reported as done.
//
// Each invariant is shown RED on a planted fault first, then GREEN after the fault is
// removed. The planted faults are documented in each describe block below.

import { describe, it, expect } from "./expect.js";
import {
  evidenceIsEmpty,
  validateWalkthrough,
  computeOutcome,
  isDone,
  isNoEvidence,
  walkthroughDigest,
  createWalkthrough,
  verifyWalkthrough
} from "../src/harness/walkthrough.js";
import { canonical } from "../src/chain.js";

const HMAC = "test-only-hmac-key-for-walkthrough-tests-0123";

// A valid 64-char hex receipt string for testing turn_receipts.
const FAKE_RECEIPT = "a".repeat(64);

// ---------------------------------------------------------------------------
// evidenceIsEmpty
// ---------------------------------------------------------------------------

describe("evidenceIsEmpty", () => {
  it("returns true for undefined, null and non-object", () => {
    expect(evidenceIsEmpty(undefined)).toBe(true);
    expect(evidenceIsEmpty(null)).toBe(true);
    expect(evidenceIsEmpty("string")).toBe(true);
    expect(evidenceIsEmpty(42)).toBe(true);
  });

  it("returns true for an empty evidence block", () => {
    expect(evidenceIsEmpty({})).toBe(true);
    expect(evidenceIsEmpty({ files_touched: [], command_output: "", turn_receipts: [] })).toBe(true);
    expect(evidenceIsEmpty({ files_touched: [], command_output: "   ", turn_receipts: [] })).toBe(true);
  });

  it("returns false when any evidence field is non-empty", () => {
    expect(evidenceIsEmpty({ files_touched: ["src/app.js"] })).toBe(false);
    expect(evidenceIsEmpty({ command_output: "all tests passed" })).toBe(false);
    expect(evidenceIsEmpty({ turn_receipts: [FAKE_RECEIPT] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateWalkthrough
// ---------------------------------------------------------------------------

describe("validateWalkthrough", () => {
  it("accepts a valid walkthrough with all fields", () => {
    const v = validateWalkthrough({
      task_id: "T3.05",
      summary: "Implemented walkthrough mechanism",
      files_touched: ["src/harness/walkthrough.js"],
      command_output: "319 pass",
      turn_receipts: [FAKE_RECEIPT],
      requested_outcome: "done"
    });
    expect(v.taskId).toBe("T3.05");
    expect(v.summary).toBe("Implemented walkthrough mechanism");
    expect(v.filesTouched).toEqual(["src/harness/walkthrough.js"]);
    expect(v.requestedOutcome).toBe("done");
  });

  it("accepts a walkthrough with only required fields", () => {
    const v = validateWalkthrough({ task_id: "T3.05", summary: "Minimal walkthrough" });
    expect(v.taskId).toBe("T3.05");
    expect(v.filesTouched).toEqual([]);
    expect(v.commandOutput).toBe("");
    expect(v.turnReceipts).toEqual([]);
    expect(v.requestedOutcome).toBe("done");
  });

  it("rejects a missing or empty task_id", () => {
    expect(() => validateWalkthrough({ task_id: "", summary: "x" })).toThrow();
    expect(() => validateWalkthrough({ task_id: undefined, summary: "x" })).toThrow();
    expect(() => validateWalkthrough({ task_id: "x y", summary: "x" })).toThrow();
  });

  it("rejects a missing or empty summary", () => {
    expect(() => validateWalkthrough({ task_id: "T3.05", summary: "" })).toThrow();
    expect(() => validateWalkthrough({ task_id: "T3.05", summary: "   " })).toThrow();
    expect(() => validateWalkthrough({ task_id: "T3.05" })).toThrow();
  });

  it("rejects an invalid requested_outcome", () => {
    expect(() => validateWalkthrough({
      task_id: "T3.05", summary: "x", requested_outcome: "maybe"
    })).toThrow();
  });

  it("filters out invalid entries in arrays", () => {
    const v = validateWalkthrough({
      task_id: "T3.05",
      summary: "x",
      files_touched: ["valid.js", "", 42, null],
      turn_receipts: [FAKE_RECEIPT, "not-hex", ""]
    });
    expect(v.filesTouched).toEqual(["valid.js"]);
    expect(v.turnReceipts).toEqual([FAKE_RECEIPT]);
  });
});

// ---------------------------------------------------------------------------
// computeOutcome - the core no-evidence invariant
// ---------------------------------------------------------------------------

describe("computeOutcome", () => {
  it("returns the requested outcome when evidence is present", () => {
    const ev = { files_touched: ["a.js"] };
    expect(computeOutcome(ev, "done")).toBe("done");
    expect(computeOutcome(ev, "blocked")).toBe("blocked");
  });

  it("forces no_evidence when evidence is empty, regardless of request", () => {
    expect(computeOutcome({}, "done")).toBe("no_evidence");
    expect(computeOutcome({ files_touched: [] }, "done")).toBe("no_evidence");
    expect(computeOutcome({ command_output: "" }, "blocked")).toBe("no_evidence");
  });

  // PLANTED FAULT F1: computeOutcome returns the requested outcome even when evidence
  // is empty. To demonstrate RED: change the first line of computeOutcome from
  //   if (evidenceIsEmpty(evidence)) return "no_evidence";
  // to
  //   if (false && evidenceIsEmpty(evidence)) return "no_evidence";
  // This test goes RED, proving the invariant is exercised.
  it("F1: does NOT return done when evidence is empty", () => {
    const outcome = computeOutcome({}, "done");
    expect(outcome).not.toBe("done");
    expect(outcome).toBe("no_evidence");
  });
});

// ---------------------------------------------------------------------------
// isDone / isNoEvidence
// ---------------------------------------------------------------------------

describe("isDone", () => {
  it("returns true only for done", () => {
    expect(isDone("done")).toBe(true);
    expect(isDone("blocked")).toBe(false);
    expect(isDone("no_evidence")).toBe(false);
  });

  // PLANTED FAULT F2: isDone returns true for "no_evidence". To demonstrate RED: change
  //   return outcome === "done";
  // to
  //   return outcome === "done" || outcome === "no_evidence";
  // This test goes RED, proving the invariant holds.
  it("F2: returns false for no_evidence (the core invariant)", () => {
    expect(isDone("no_evidence")).toBe(false);
  });
});

describe("isNoEvidence", () => {
  it("returns true only for no_evidence", () => {
    expect(isNoEvidence("no_evidence")).toBe(true);
    expect(isNoEvidence("done")).toBe(false);
    expect(isNoEvidence("blocked")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createWalkthrough - end-to-end artifact creation
// ---------------------------------------------------------------------------

describe("createWalkthrough", () => {
  it("creates a sealed artifact with digest and receipt", async () => {
    const { artifact, receipt } = await createWalkthrough(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      task_id: "T3.05",
      summary: "Built walkthrough module",
      files_touched: ["src/harness/walkthrough.js", "test/walkthrough.test.js"],
      command_output: "node --test 319 pass",
      turn_receipts: [FAKE_RECEIPT],
      requested_outcome: "done",
      ts: 1_700_000_000
    });

    expect(artifact.task_id).toBe("T3.05");
    expect(artifact.outcome).toBe("done");
    expect(artifact.entity_id).toBe("agent-emp-001");
    expect(artifact.employee_id).toBe("emp-001");
    expect(artifact.evidence.files_touched.length).toBe(2);
    expect(artifact.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt).toMatch(/^[0-9a-f]{64}$/);
  });

  it("forces no_evidence when evidence is empty even if done is requested", async () => {
    const { artifact } = await createWalkthrough(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      task_id: "T3.05",
      summary: "Task with no evidence",
      requested_outcome: "done",
      ts: 1_700_000_000
    });

    expect(artifact.outcome).toBe("no_evidence");
    expect(isDone(artifact.outcome)).toBe(false);
    expect(isNoEvidence(artifact.outcome)).toBe(true);
  });

  it("allows blocked outcome when evidence is present", async () => {
    const { artifact } = await createWalkthrough(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      task_id: "T3.05",
      summary: "Blocked task",
      files_touched: ["src/harness/walkthrough.js"],
      requested_outcome: "blocked",
      ts: 1_700_000_000
    });

    expect(artifact.outcome).toBe("blocked");
    expect(isDone(artifact.outcome)).toBe(false);
  });

  it("uses a default timestamp when ts is not provided", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { artifact } = await createWalkthrough(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      task_id: "T3.05",
      summary: "Default ts",
      files_touched: ["x.js"]
    });
    const after = Math.floor(Date.now() / 1000);
    expect(artifact.ts >= before).toBe(true);
    expect(artifact.ts <= after).toBe(true);
  });

  it("rejects a missing summary", async () => {
    let threw = false;
    try {
      await createWalkthrough(HMAC, {
        employeeId: "emp-001",
        entityId: "agent-emp-001",
        task_id: "T3.05",
        summary: ""
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// walkthroughDigest - tamper evidence
// ---------------------------------------------------------------------------

describe("walkthroughDigest", () => {
  it("produces a stable 64-char hex digest", async () => {
    const body = { task_id: "T3.05", summary: "x", outcome: "done", ts: 100 };
    const d1 = await walkthroughDigest(body);
    const d2 = await walkthroughDigest(body);
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any field changes", async () => {
    const body1 = { task_id: "T3.05", summary: "x", outcome: "done", ts: 100 };
    const body2 = { task_id: "T3.05", summary: "y", outcome: "done", ts: 100 };
    const d1 = await walkthroughDigest(body1);
    const d2 = await walkthroughDigest(body2);
    expect(d1).not.toBe(d2);
  });

  // PLANTED FAULT F3: walkthroughDigest includes the digest field in the canonical input,
  // creating a circular dependency. To demonstrate RED: change
  //   return sha256Hex(enc.encode(canonical({ kind: WALKTHROUGH_KIND, ...body })));
  // to
  //   return sha256Hex(enc.encode(canonical({ kind: WALKTHROUGH_KIND, ...body, digest: "circular" })));
  // The verify test goes RED because the recomputed digest never matches.
  it("F3: does not include digest in its own hash (no circular dependency)", async () => {
    const body = { task_id: "T3.05", summary: "x", entity_id: "e1", employee_id: "emp1", evidence: {}, outcome: "no_evidence", ts: 100 };
    const d = await walkthroughDigest(body);
    // If digest were included, adding a digest field to the body would change the hash.
    // Instead, verify that the digest is deterministic and does not depend on a digest field.
    const bodyWithDigest = { ...body, digest: d };
    const d2 = await walkthroughDigest(bodyWithDigest);
    expect(d).not.toBe(d2); // confirms digest field WOULD change it (so verify strips it)
  });
});

// ---------------------------------------------------------------------------
// verifyWalkthrough - integrity and invariant checks
// ---------------------------------------------------------------------------

describe("verifyWalkthrough", () => {
  it("verifies a valid artifact with evidence", async () => {
    const { artifact, receipt } = await createWalkthrough(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      task_id: "T3.05",
      summary: "Built walkthrough",
      files_touched: ["src/harness/walkthrough.js"],
      command_output: "319 pass",
      ts: 1_700_000_000
    });
    const ok = await verifyWalkthrough(HMAC, artifact, receipt);
    expect(ok).toBe(true);
  });

  it("verifies a no_evidence artifact", async () => {
    const { artifact, receipt } = await createWalkthrough(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      task_id: "T3.05",
      summary: "No evidence task",
      ts: 1_700_000_000
    });
    expect(artifact.outcome).toBe("no_evidence");
    const ok = await verifyWalkthrough(HMAC, artifact, receipt);
    expect(ok).toBe(true);
  });

  it("rejects a tampered summary", async () => {
    const { artifact, receipt } = await createWalkthrough(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      task_id: "T3.05",
      summary: "Original",
      files_touched: ["x.js"],
      ts: 1_700_000_000
    });
    artifact.summary = "Tampered";
    const ok = await verifyWalkthrough(HMAC, artifact, receipt);
    expect(ok).toBe(false);
  });

  it("rejects a tampered digest", async () => {
    const { artifact, receipt } = await createWalkthrough(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      task_id: "T3.05",
      summary: "Original",
      files_touched: ["x.js"],
      ts: 1_700_000_000
    });
    artifact.digest = "b".repeat(64);
    const ok = await verifyWalkthrough(HMAC, artifact, receipt);
    expect(ok).toBe(false);
  });

  it("rejects a wrong receipt", async () => {
    const { artifact } = await createWalkthrough(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      task_id: "T3.05",
      summary: "Original",
      files_touched: ["x.js"],
      ts: 1_700_000_000
    });
    const ok = await verifyWalkthrough(HMAC, artifact, "c".repeat(64));
    expect(ok).toBe(false);
  });

  it("rejects a receipt from a different key", async () => {
    const { artifact, receipt } = await createWalkthrough(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      task_id: "T3.05",
      summary: "Original",
      files_touched: ["x.js"],
      ts: 1_700_000_000
    });
    const ok = await verifyWalkthrough("different-key-entirely-0123456789abcdef", artifact, receipt);
    expect(ok).toBe(false);
  });

  // PLANTED FAULT F4: verifyWalkthrough skips the no-evidence invariant check. To
  // demonstrate RED: remove the computeOutcome check at the end of verifyWalkthrough,
  // so an artifact with empty evidence but outcome "done" passes verification.
  it("F4: rejects an artifact with empty evidence but outcome done", async () => {
    const { artifact, receipt } = await createWalkthrough(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      task_id: "T3.05",
      summary: "No evidence",
      ts: 1_700_000_000
    });
    // createWalkthrough correctly forces no_evidence. Now tamper the outcome to "done"
    // and recompute a fake receipt to isolate the invariant check.
    expect(artifact.outcome).toBe("no_evidence");

    // Tamper: set outcome to "done" despite empty evidence.
    artifact.outcome = "done";

    // The digest no longer matches (outcome changed), so verification should fail
    // even before the invariant check. But to isolate F4 specifically, recompute
    // the digest over the tampered body so only the invariant check catches it.
    const { sha256Hex } = await import("../src/chain.js");
    const enc = new TextEncoder();
    const { digest: _d, ...body } = artifact;
    void _d;
    artifact.digest = await sha256Hex(enc.encode(canonical({ kind: "nhe-relay/walkthrough", ...body })));

    // Recompute receipt for the tampered artifact so the receipt check passes.
    const { issueReceipt } = await import("../src/chain.js");
    const fakeReceipt = await issueReceipt(HMAC, {
      entity_id: artifact.entity_id,
      session_hash: artifact.digest,
      tool: "walkthrough",
      outcome: "done",
      ts: artifact.ts
    });

    const ok = await verifyWalkthrough(HMAC, artifact, fakeReceipt);
    expect(ok).toBe(false); // F4: the invariant check must catch this
  });

  it("rejects a non-object artifact", async () => {
    const ok = await verifyWalkthrough(HMAC, null, "x");
    expect(ok).toBe(false);
  });

  it("rejects an artifact with an invalid outcome", async () => {
    const { artifact, receipt } = await createWalkthrough(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      task_id: "T3.05",
      summary: "x",
      files_touched: ["y.js"],
      ts: 1_700_000_000
    });
    artifact.outcome = "maybe";
    const ok = await verifyWalkthrough(HMAC, artifact, receipt);
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MCP integration: soul.walkthrough through handleMcp
// ---------------------------------------------------------------------------

describe("soul.walkthrough via MCP server", () => {
  const HMAC_KEY = "test-only-hmac-key-for-walkthrough-mcp-0123";


  it("issues a walkthrough artifact through tools/call", async () => {
    const mod = await import("../src/harness/mcp-server.js");
    const cfg = await import("../src/harness/config.js");
    const login = await import("../src/harness/login.js");

    const harness = cfg.loadHarnessConfig({
      enabled: true,
      token_ttl_sec: 3600,
      employees: [{ id: "emp-001", entity_id: "agent-emp-001", credential: "EMP_001_KEY", grants: ["soul.*"] }],
      soul: { url: "https://soul-svc.test/mcp", secret: "SOUL_KEY", timeout_ms: 2000 },
      tiresias: { url: "https://tiresias.test/api", secret: "TIRESIAS_KEY", agent: "acme", timeout_ms: 1000 }
    });
    const env = {
      RELAY_ENABLED: "yes", RELAY_HMAC_KEY: HMAC_KEY,
      EMP_001_KEY: "emp-secret-001", SOUL_KEY: "soul-secret", TIRESIAS_KEY: "tiresias-secret"
    };
    const { token } = await login.issueToken(HMAC_KEY, {
      employeeId: "emp-001", entityId: "agent-emp-001", ttlSec: 3600, now: 1_700_000_000_000
    });
    const headers = new Headers();
    headers.set("authorization", "Bearer " + token);

    const fetcher = async (url) => {
      if (url === "https://tiresias.test/api") return new Response(JSON.stringify({ contract: "tiresias.enterprise.decision/v1", decision: "allow" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200 });
    };

    const r = await mod.handleMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "soul.walkthrough",
        arguments: {
          task_id: "T3.05",
          summary: "Built walkthrough via MCP",
          files_touched: ["src/harness/walkthrough.js"],
          command_output: "319 pass",
          requested_outcome: "done"
        }
      }},
      env,
      { harness, headers, fetcher, env, now: () => 1_700_000_000_000, log: () => {} }
    );

    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(false);
    expect(r.body.result.structuredContent.artifact.outcome).toBe("done");
    expect(r.body.result.structuredContent.artifact.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.result.structuredContent.receipt).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.result._meta.receipt).toMatch(/^[0-9a-f]{64}$/);
  });

  it("forces no_evidence through MCP when evidence is empty", async () => {
    const mod = await import("../src/harness/mcp-server.js");
    const cfg = await import("../src/harness/config.js");
    const login = await import("../src/harness/login.js");

    const harness = cfg.loadHarnessConfig({
      enabled: true,
      token_ttl_sec: 3600,
      employees: [{ id: "emp-001", entity_id: "agent-emp-001", credential: "EMP_001_KEY", grants: ["soul.*"] }],
      soul: { url: "https://soul-svc.test/mcp", secret: "SOUL_KEY", timeout_ms: 2000 },
      tiresias: { url: "https://tiresias.test/api", secret: "TIRESIAS_KEY", agent: "acme", timeout_ms: 1000 }
    });
    const env = {
      RELAY_ENABLED: "yes", RELAY_HMAC_KEY: HMAC_KEY,
      EMP_001_KEY: "emp-secret-001", SOUL_KEY: "soul-secret", TIRESIAS_KEY: "tiresias-secret"
    };
    const { token } = await login.issueToken(HMAC_KEY, {
      employeeId: "emp-001", entityId: "agent-emp-001", ttlSec: 3600, now: 1_700_000_000_000
    });
    const headers = new Headers();
    headers.set("authorization", "Bearer " + token);

    const fetcher = async (url) => {
      if (url === "https://tiresias.test/api") return new Response(JSON.stringify({ contract: "tiresias.enterprise.decision/v1", decision: "allow" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200 });
    };

    const r = await mod.handleMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "soul.walkthrough",
        arguments: {
          task_id: "T3.05",
          summary: "No evidence via MCP",
          requested_outcome: "done"
        }
      }},
      env,
      { harness, headers, fetcher, env, now: () => 1_700_000_000_000, log: () => {} }
    );

    expect(r.status).toBe(200);
    expect(r.body.result.structuredContent.artifact.outcome).toBe("no_evidence");
  });
});

// ---------------------------------------------------------------------------
// End to end: create then verify a walkthrough with real chain operations
// ---------------------------------------------------------------------------

describe("end to end: walkthrough lifecycle", () => {
  it("create -> verify round-trips for a done task", async () => {
    const { artifact, receipt } = await createWalkthrough(HMAC, {
      employeeId: "emp-full",
      entityId: "agent-emp-full",
      task_id: "T3.05",
      summary: "Implemented task walkthrough (D21 item 1): every agent task ends with a walkthrough artifact hashed into the turn chain. No evidence means no_evidence, never done.",
      files_touched: ["src/harness/walkthrough.js", "src/harness/tools.js", "src/harness/mcp-server.js", "test/walkthrough.test.js"],
      command_output: "node --test 319 pass 0 fail",
      turn_receipts: [FAKE_RECEIPT],
      requested_outcome: "done",
      ts: 1_700_000_000
    });

    expect(artifact.outcome).toBe("done");
    expect(isDone(artifact.outcome)).toBe(true);

    const ok = await verifyWalkthrough(HMAC, artifact, receipt);
    expect(ok).toBe(true);
  });

  it("create -> verify round-trips for a no_evidence task", async () => {
    const { artifact, receipt } = await createWalkthrough(HMAC, {
      employeeId: "emp-full",
      entityId: "agent-emp-full",
      task_id: "T3.99",
      summary: "Task attempted but produced no verifiable evidence",
      requested_outcome: "done",
      ts: 1_700_000_000
    });

    expect(artifact.outcome).toBe("no_evidence");
    expect(isDone(artifact.outcome)).toBe(false);

    const ok = await verifyWalkthrough(HMAC, artifact, receipt);
    expect(ok).toBe(true);
  });
});
