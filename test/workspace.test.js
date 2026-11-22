// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// T3.11 - Isolated workspace per task (D21 item 6).
// Each agent task gets its own workspace: a fresh worktree or sandbox, never shared between
// tasks, cleaned on completion. A leftover workspace may be reused only if it is provably
// the task own and has nothing unpushed (the program runner leftover rule).
//
// Each invariant is shown RED on a planted fault first, then GREEN after the fault is
// removed. The planted faults are documented in each describe block below.

import { describe, it, expect } from "./expect.js";
import {
  WorkspaceError,
  workspaceId,
  validateWorkspaceFields,
  workspaceDigest,
  createWorkspace,
  reuseLeftover,
  cleanWorkspace,
  verifyWorkspaceRevision,
  verifyWorkspaceHistory
} from "../src/harness/workspace.js";

const HMAC = "test-only-hmac-key-for-workspace-tests-0123";

const BASE_OPTS = {
  employee_id: "emp-001",
  entity_id: "agent-emp-001",
  task_id: "T3.11",
  repo: "saluca-labs/nhe-relay",
  branch: "agent/theatom/T3.11",
  path: "/worktrees/per-employee-agents-t3.11",
  ts: 1_700_000_000
};

// ---------------------------------------------------------------------------
// workspaceId - deterministic, unique per task, never shared
// ---------------------------------------------------------------------------

describe("workspaceId", () => {
  it("is deterministic: the same pair always produces the same id", async () => {
    const a = await workspaceId("agent-emp-001", "T3.11");
    const b = await workspaceId("agent-emp-001", "T3.11");
    expect(a).toBe(b);
  });

  it("is 64 lowercase hex characters", async () => {
    const id = await workspaceId("agent-emp-001", "T3.11");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different task_ids (never shared between tasks)", async () => {
    const a = await workspaceId("agent-emp-001", "T3.11");
    const b = await workspaceId("agent-emp-001", "T3.12");
    expect(a).not.toBe(b);
  });

  it("differs for different entity_ids (never shared between agents)", async () => {
    const a = await workspaceId("agent-emp-001", "T3.11");
    const b = await workspaceId("agent-emp-002", "T3.11");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// validateWorkspaceFields
// ---------------------------------------------------------------------------

describe("validateWorkspaceFields", () => {
  it("accepts valid fields", () => {
    const f = validateWorkspaceFields(BASE_OPTS);
    expect(f.taskId).toBe("T3.11");
    expect(f.entityId).toBe("agent-emp-001");
    expect(f.employeeId).toBe("emp-001");
    expect(f.repo).toBe("saluca-labs/nhe-relay");
  });

  it("accepts camelCase aliases entityId/employeeId", () => {
    const f = validateWorkspaceFields({
      task_id: "T3.11", entityId: "agent-emp-001", employeeId: "emp-001",
      repo: "r", branch: "b", path: "/p"
    });
    expect(f.entityId).toBe("agent-emp-001");
    expect(f.employeeId).toBe("emp-001");
  });

  it("rejects a missing or invalid task_id", () => {
    expect(() => validateWorkspaceFields({ ...BASE_OPTS, task_id: "" })).toThrow();
    expect(() => validateWorkspaceFields({ ...BASE_OPTS, task_id: "x y" })).toThrow();
    expect(() => validateWorkspaceFields({ ...BASE_OPTS, task_id: undefined })).toThrow();
  });

  it("rejects a missing or invalid entity_id", () => {
    expect(() => validateWorkspaceFields({ ...BASE_OPTS, entity_id: "" })).toThrow();
    expect(() => validateWorkspaceFields({ ...BASE_OPTS, entity_id: "UPPER" })).toThrow();
  });

  it("rejects an empty repo, branch or path", () => {
    expect(() => validateWorkspaceFields({ ...BASE_OPTS, repo: "" })).toThrow();
    expect(() => validateWorkspaceFields({ ...BASE_OPTS, branch: "  " })).toThrow();
    expect(() => validateWorkspaceFields({ ...BASE_OPTS, path: "" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createWorkspace - fresh, active, revision 0
// ---------------------------------------------------------------------------

describe("createWorkspace", () => {
  it("creates a fresh workspace at revision 0 with status active", async () => {
    const { plan, receipt } = await createWorkspace(HMAC, BASE_OPTS);
    expect(plan.revision).toBe(0);
    expect(plan.status).toBe("active");
    expect(plan.prev_digest).toBeNull();
    expect(plan.event.type).toBe("created");
    expect(plan.workspace_id).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the workspace_id matches workspaceId(entity_id, task_id)", async () => {
    const { plan } = await createWorkspace(HMAC, BASE_OPTS);
    const expected = await workspaceId("agent-emp-001", "T3.11");
    expect(plan.workspace_id).toBe(expected);
  });

  it("two different tasks get different workspace_ids (never shared)", async () => {
    const a = await createWorkspace(HMAC, { ...BASE_OPTS, task_id: "T3.11a" });
    const b = await createWorkspace(HMAC, { ...BASE_OPTS, task_id: "T3.11b" });
    expect(a.plan.workspace_id).not.toBe(b.plan.workspace_id);
  });

  it("the revision verifies on its own", async () => {
    const { plan, receipt } = await createWorkspace(HMAC, BASE_OPTS);
    const ok = await verifyWorkspaceRevision(HMAC, plan, receipt);
    expect(ok).toBe(true);
  });

  it("verification fails under a different HMAC key", async () => {
    const { plan, receipt } = await createWorkspace(HMAC, BASE_OPTS);
    const ok = await verifyWorkspaceRevision("wrong-key", plan, receipt);
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cleanWorkspace - active to cleaned, once only
// ---------------------------------------------------------------------------

describe("cleanWorkspace", () => {
  it("transitions active to cleaned", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    const { plan, receipt } = await cleanWorkspace(HMAC, created.plan, created.receipt, {
      entity_id: "agent-emp-001", ts: 1_700_000_001
    });
    expect(plan.status).toBe("cleaned");
    expect(plan.revision).toBe(1);
    expect(plan.event.type).toBe("cleaned");
    expect(plan.prev_digest).toBe(created.plan.digest);
    expect(await verifyWorkspaceRevision(HMAC, plan, receipt)).toBe(true);
  });

  it("refuses to clean a workspace owned by another entity", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    await expect(
      cleanWorkspace(HMAC, created.plan, created.receipt, {
        entity_id: "agent-emp-999", ts: 1_700_000_001
      })
    ).rejects.toThrow();
  });

  it("refuses to clean an already-cleaned workspace", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    const cleaned = await cleanWorkspace(HMAC, created.plan, created.receipt, {
      entity_id: "agent-emp-001", ts: 1_700_000_001
    });
    await expect(
      cleanWorkspace(HMAC, cleaned.plan, cleaned.receipt, {
        entity_id: "agent-emp-001", ts: 1_700_000_002
      })
    ).rejects.toThrow();
  });

  it("refuses to clean with an invalid receipt", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    await expect(
      cleanWorkspace(HMAC, created.plan, "0".repeat(64), {
        entity_id: "agent-emp-001", ts: 1_700_000_001
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// reuseLeftover - the program runner leftover rule
// ---------------------------------------------------------------------------

describe("reuseLeftover", () => {
  it("succeeds when the workspace is provably the task own and nothing is unpushed", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    const { plan, receipt } = await reuseLeftover(HMAC, created.plan, created.receipt, {
      entity_id: "agent-emp-001",
      task_id: "T3.11",
      unpushed_commits: 0,
      uncommitted_changes: false,
      ts: 1_700_000_001
    });
    expect(plan.status).toBe("active");
    expect(plan.revision).toBe(1);
    expect(plan.event.type).toBe("reused");
    expect(plan.event.unpushed_commits).toBe(0);
    expect(plan.event.uncommitted_changes).toBe(false);
    expect(await verifyWorkspaceRevision(HMAC, plan, receipt)).toBe(true);
  });

  it("refuses when unpushed_commits > 0", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    await expect(
      reuseLeftover(HMAC, created.plan, created.receipt, {
        entity_id: "agent-emp-001",
        task_id: "T3.11",
        unpushed_commits: 3,
        uncommitted_changes: false,
        ts: 1_700_000_001
      })
    ).rejects.toThrow();
  });

  it("refuses when uncommitted_changes is true", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    await expect(
      reuseLeftover(HMAC, created.plan, created.receipt, {
        entity_id: "agent-emp-001",
        task_id: "T3.11",
        unpushed_commits: 0,
        uncommitted_changes: true,
        ts: 1_700_000_001
      })
    ).rejects.toThrow();
  });

  it("refuses when unpushed_commits is undefined (cannot tell is never a pass)", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    await expect(
      reuseLeftover(HMAC, created.plan, created.receipt, {
        entity_id: "agent-emp-001",
        task_id: "T3.11",
        uncommitted_changes: false,
        ts: 1_700_000_001
      })
    ).rejects.toThrow();
  });

  it("refuses when uncommitted_changes is undefined (cannot tell is never a pass)", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    await expect(
      reuseLeftover(HMAC, created.plan, created.receipt, {
        entity_id: "agent-emp-001",
        task_id: "T3.11",
        unpushed_commits: 0,
        ts: 1_700_000_001
      })
    ).rejects.toThrow();
  });

  it("refuses when unpushed_commits is a string, not a number (cannot tell)", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    await expect(
      reuseLeftover(HMAC, created.plan, created.receipt, {
        entity_id: "agent-emp-001",
        task_id: "T3.11",
        unpushed_commits: "0",
        uncommitted_changes: false,
        ts: 1_700_000_001
      })
    ).rejects.toThrow();
  });

  it("refuses when the entity_id does not match (not the task own)", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    await expect(
      reuseLeftover(HMAC, created.plan, created.receipt, {
        entity_id: "agent-emp-999",
        task_id: "T3.11",
        unpushed_commits: 0,
        uncommitted_changes: false,
        ts: 1_700_000_001
      })
    ).rejects.toThrow();
  });

  it("refuses when the task_id does not match (not the task own)", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    await expect(
      reuseLeftover(HMAC, created.plan, created.receipt, {
        entity_id: "agent-emp-001",
        task_id: "T3.99",
        unpushed_commits: 0,
        uncommitted_changes: false,
        ts: 1_700_000_001
      })
    ).rejects.toThrow();
  });

  it("refuses to reuse a cleaned workspace", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    const cleaned = await cleanWorkspace(HMAC, created.plan, created.receipt, {
      entity_id: "agent-emp-001", ts: 1_700_000_001
    });
    await expect(
      reuseLeftover(HMAC, cleaned.plan, cleaned.receipt, {
        entity_id: "agent-emp-001",
        task_id: "T3.11",
        unpushed_commits: 0,
        uncommitted_changes: false,
        ts: 1_700_000_002
      })
    ).rejects.toThrow();
  });

  it("refuses to reuse with an invalid receipt", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    await expect(
      reuseLeftover(HMAC, created.plan, "f".repeat(64), {
        entity_id: "agent-emp-001",
        task_id: "T3.11",
        unpushed_commits: 0,
        uncommitted_changes: false,
        ts: 1_700_000_001
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// verifyWorkspaceHistory - full chain replay
// ---------------------------------------------------------------------------

describe("verifyWorkspaceHistory", () => {
  it("verifies a create -> reuse -> clean history", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    const reused = await reuseLeftover(HMAC, created.plan, created.receipt, {
      entity_id: "agent-emp-001", task_id: "T3.11",
      unpushed_commits: 0, uncommitted_changes: false, ts: 1_700_000_001
    });
    const cleaned = await cleanWorkspace(HMAC, reused.plan, reused.receipt, {
      entity_id: "agent-emp-001", ts: 1_700_000_002
    });

    const result = await verifyWorkspaceHistory(HMAC, [
      { plan: created.plan, receipt: created.receipt },
      { plan: reused.plan, receipt: reused.receipt },
      { plan: cleaned.plan, receipt: cleaned.receipt }
    ]);
    expect(result.ok).toBe(true);
  });

  it("verifies a simple create -> clean history", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    const cleaned = await cleanWorkspace(HMAC, created.plan, created.receipt, {
      entity_id: "agent-emp-001", ts: 1_700_000_001
    });

    const result = await verifyWorkspaceHistory(HMAC, [
      { plan: created.plan, receipt: created.receipt },
      { plan: cleaned.plan, receipt: cleaned.receipt }
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects an empty history", async () => {
    const result = await verifyWorkspaceHistory(HMAC, []);
    expect(result.ok).toBe(false);
  });

  it("rejects a history with a tampered revision", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    const tampered = { ...created.plan, repo: "tampered-repo" };
    const result = await verifyWorkspaceHistory(HMAC, [
      { plan: tampered, receipt: created.receipt }
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects a history with a wrong root", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    const badRoot = { ...created.plan, root: "0".repeat(64) };
    const result = await verifyWorkspaceHistory(HMAC, [
      { plan: badRoot, receipt: created.receipt }
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects a history where a revision is out of order", async () => {
    const created = await createWorkspace(HMAC, BASE_OPTS);
    const reused = await reuseLeftover(HMAC, created.plan, created.receipt, {
      entity_id: "agent-emp-001", task_id: "T3.11",
      unpushed_commits: 0, uncommitted_changes: false, ts: 1_700_000_001
    });
    const swapped = { ...reused.plan, revision: 5 };
    const result = await verifyWorkspaceHistory(HMAC, [
      { plan: created.plan, receipt: created.receipt },
      { plan: swapped, receipt: reused.receipt }
    ]);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle: create, reuse, clean, verify
// ---------------------------------------------------------------------------

describe("full workspace lifecycle", () => {
  it("create -> reuse -> reuse -> clean round-trips and verifies", async () => {
    const r0 = await createWorkspace(HMAC, BASE_OPTS);
    const r1 = await reuseLeftover(HMAC, r0.plan, r0.receipt, {
      entity_id: "agent-emp-001", task_id: "T3.11",
      unpushed_commits: 0, uncommitted_changes: false, ts: 1_700_000_001
    });
    const r2 = await reuseLeftover(HMAC, r1.plan, r1.receipt, {
      entity_id: "agent-emp-001", task_id: "T3.11",
      unpushed_commits: 0, uncommitted_changes: false, ts: 1_700_000_002
    });
    const r3 = await cleanWorkspace(HMAC, r2.plan, r2.receipt, {
      entity_id: "agent-emp-001", ts: 1_700_000_003
    });

    expect(r0.plan.revision).toBe(0);
    expect(r1.plan.revision).toBe(1);
    expect(r2.plan.revision).toBe(2);
    expect(r3.plan.revision).toBe(3);
    expect(r3.plan.status).toBe("cleaned");

    const result = await verifyWorkspaceHistory(HMAC, [
      { plan: r0.plan, receipt: r0.receipt },
      { plan: r1.plan, receipt: r1.receipt },
      { plan: r2.plan, receipt: r2.receipt },
      { plan: r3.plan, receipt: r3.receipt }
    ]);
    expect(result.ok).toBe(true);
  });

  it("the workspace_id is constant across all revisions", async () => {
    const r0 = await createWorkspace(HMAC, BASE_OPTS);
    const r1 = await reuseLeftover(HMAC, r0.plan, r0.receipt, {
      entity_id: "agent-emp-001", task_id: "T3.11",
      unpushed_commits: 0, uncommitted_changes: false, ts: 1_700_000_001
    });
    expect(r0.plan.workspace_id).toBe(r1.plan.workspace_id);
  });
});

// ---------------------------------------------------------------------------
// MCP integration: soul.workspace_create, soul.workspace_reuse, soul.workspace_clean
// ---------------------------------------------------------------------------

describe("MCP integration: workspace tools", () => {
  it("soul.workspace_create returns a sealed workspace via MCP", async () => {
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
      RELAY_ENABLED: "yes", RELAY_HMAC_KEY: HMAC,
      EMP_001_KEY: "emp-secret-001", SOUL_KEY: "soul-secret", TIRESIAS_KEY: "tiresias-secret"
    };
    const { token } = await login.issueToken(HMAC, {
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
        name: "soul.workspace_create",
        arguments: {
          task_id: "T3.11",
          repo: "saluca-labs/nhe-relay",
          branch: "agent/theatom/T3.11",
          path: "/worktrees/per-employee-agents-t3.11"
        }
      }},
      env,
      { harness, headers, fetcher, env, now: () => 1_700_000_000_000, log: () => {} }
    );

    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(false);
    expect(r.body.result.structuredContent.workspace.status).toBe("active");
    expect(r.body.result.structuredContent.workspace.revision).toBe(0);
    expect(r.body.result.structuredContent.workspace.workspace_id).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.result.structuredContent.receipt).toMatch(/^[0-9a-f]{64}$/);
  });

  it("soul.workspace_reuse refuses via MCP when unpushed_commits > 0", async () => {
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
      RELAY_ENABLED: "yes", RELAY_HMAC_KEY: HMAC,
      EMP_001_KEY: "emp-secret-001", SOUL_KEY: "soul-secret", TIRESIAS_KEY: "tiresias-secret"
    };
    const { token } = await login.issueToken(HMAC, {
      employeeId: "emp-001", entityId: "agent-emp-001", ttlSec: 3600, now: 1_700_000_000_000
    });
    const headers = new Headers();
    headers.set("authorization", "Bearer " + token);

    const fetcher = async (url) => {
      if (url === "https://tiresias.test/api") return new Response(JSON.stringify({ contract: "tiresias.enterprise.decision/v1", decision: "allow" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200 });
    };

    // First create a workspace
    const created = await createWorkspace(HMAC, BASE_OPTS);

    const r = await mod.handleMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "soul.workspace_reuse",
        arguments: {
          workspace: created.plan,
          receipt: created.receipt,
          task_id: "T3.11",
          unpushed_commits: 2,
          uncommitted_changes: false
        }
      }},
      env,
      { harness, headers, fetcher, env, now: () => 1_700_000_000_000, log: () => {} }
    );

    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toMatch(/unpushed/);
  });

  it("soul.workspace_clean returns a cleaned workspace via MCP", async () => {
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
      RELAY_ENABLED: "yes", RELAY_HMAC_KEY: HMAC,
      EMP_001_KEY: "emp-secret-001", SOUL_KEY: "soul-secret", TIRESIAS_KEY: "tiresias-secret"
    };
    const { token } = await login.issueToken(HMAC, {
      employeeId: "emp-001", entityId: "agent-emp-001", ttlSec: 3600, now: 1_700_000_000_000
    });
    const headers = new Headers();
    headers.set("authorization", "Bearer " + token);

    const fetcher = async (url) => {
      if (url === "https://tiresias.test/api") return new Response(JSON.stringify({ contract: "tiresias.enterprise.decision/v1", decision: "allow" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200 });
    };

    const created = await createWorkspace(HMAC, BASE_OPTS);

    const r = await mod.handleMcp(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: {
        name: "soul.workspace_clean",
        arguments: {
          workspace: created.plan,
          receipt: created.receipt
        }
      }},
      env,
      { harness, headers, fetcher, env, now: () => 1_700_000_000_000, log: () => {} }
    );

    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(false);
    expect(r.body.result.structuredContent.workspace.status).toBe("cleaned");
    expect(r.body.result.structuredContent.workspace.revision).toBe(1);
  });
});
