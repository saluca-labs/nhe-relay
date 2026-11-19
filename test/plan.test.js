// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// T3.07 - Commentable plans (D21 item 2).
// Before work starts the agent posts a plan the employee can comment on inline; comments
// become plan revisions in the turn chain; Proceed releases only ungated steps, and the plan
// lists up front which steps will become proposals (a card each).
//
// Each rule below was shown RED on a planted fault before it counted. The faults are the
// "plan:" entries in tools/guard-mutations.mjs (P1-P8); `npm run mutants` replays them all.

import { describe, it, expect } from "./expect.js";
import {
  UNGATED_ACTIONS,
  GATED_ACTIONS,
  classifyAction,
  normaliseSteps,
  proposalsOf,
  createPlan,
  commentOnPlan,
  revisePlan,
  proceedPlan,
  releasedSteps,
  mayExecute,
  proposalCards,
  verifyPlanRevision,
  verifyPlanHistory,
  planDigest
} from "../src/harness/plan.js";
import { issueReceipt, genesis, nextRoot } from "../src/chain.js";
import { TOOLS } from "../src/harness/tools.js";

const HMAC = "test-only-hmac-key-for-plan-tests-0123456789";
const EMP = "emp-001";
const ENT = "agent-emp-001";

const STEPS = [
  { id: "s1", text: "Read the current approval adapter\nand list its entry points", action: "read" },
  { id: "s2", text: "Edit the adapter to carry the plan digest", action: "edit" },
  { id: "s3", text: "Run the adapter tests", action: "test" },
  { id: "s4", text: "Deploy the adapter to the reference install", action: "deploy" },
  { id: "s5", text: "Send the release note to the team channel", action: "send" }
];

async function posted(steps = STEPS) {
  return createPlan(HMAC, { employeeId: EMP, entityId: ENT, task_id: "T3.07", summary: "Carry the plan digest on the card", steps, ts: 1_700_000_000 });
}

async function refuses(p) {
  try {
    await p;
  } catch {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rule 1: every step's action is mapped; unknown is a refusal (P1)
// ---------------------------------------------------------------------------

describe("plan: step actions", () => {
  it("classifies the ungated and gated lists, and the lists do not overlap", () => {
    for (const a of UNGATED_ACTIONS) expect(classifyAction(a)).toBe(false);
    for (const a of GATED_ACTIONS) expect(classifyAction(a)).toBe(true);
    for (const a of UNGATED_ACTIONS) expect(GATED_ACTIONS.includes(a)).toBe(false);
  });

  it("P1: an unmapped action is refused, never defaulted to ungated", async () => {
    expect(() => classifyAction("tweet")).toThrow();
    expect(() => classifyAction("")).toThrow();
    expect(() => classifyAction(undefined)).toThrow();
    expect(await refuses(posted([{ id: "s1", text: "Post it", action: "tweet" }]))).toBe(true);
  });

  it("refuses malformed step lists", () => {
    expect(() => normaliseSteps([])).toThrow();
    expect(() => normaliseSteps("s1")).toThrow();
    expect(() => normaliseSteps([{ id: "s1", text: "", action: "read" }])).toThrow();
    expect(() => normaliseSteps([{ id: "bad id", text: "x", action: "read" }])).toThrow();
    expect(() => normaliseSteps([{ id: "s1", text: "x", action: "read" }, { id: "s1", text: "y", action: "read" }])).toThrow();
    expect(() => normaliseSteps([{ id: "s1", text: "x", action: "read", extra: 1 }])).toThrow();
    expect(() => normaliseSteps([{ id: "s1", text: "x", action: "read", gated: "yes" }])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Rule 2: the agent may only narrow (P2)
// ---------------------------------------------------------------------------

describe("plan: gating may only narrow", () => {
  it("lets the agent mark an ungated step as gated", () => {
    const [s] = normaliseSteps([{ id: "s1", text: "Edit the shared config", action: "edit", gated: true }]);
    expect(s.gated).toBe(true);
  });

  it("P2: refuses an attempt to mark a gated action as ungated", async () => {
    expect(() => normaliseSteps([{ id: "s1", text: "Send it", action: "send", gated: false }])).toThrow();
    expect(await refuses(posted([{ id: "s1", text: "Publish it", action: "publish", gated: false }]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: proposals listed up front, a card each (P8)
// ---------------------------------------------------------------------------

describe("plan: proposals are listed up front", () => {
  it("P8: revision 0 lists every gated step as a proposal, in plan order", async () => {
    const { plan } = await posted();
    expect(plan.revision).toBe(0);
    expect(plan.status).toBe("awaiting_review");
    expect(plan.proposals).toEqual(["s4", "s5"]);
    expect(proposalsOf(plan.steps)).toEqual(["s4", "s5"]);
  });

  it("gives one card per gated step, bound to the plan digest", async () => {
    const { plan } = await posted();
    const cards = proposalCards(plan);
    expect(cards.length).toBe(2);
    expect(cards.map((c) => c.step_id)).toEqual(["s4", "s5"]);
    expect(cards[0]).toMatchObject({ task_id: "T3.07", action: "deploy", plan_digest: plan.digest });
  });

  it("an agent-narrowed step becomes a proposal too", async () => {
    const { plan } = await posted([{ id: "s1", text: "Edit the shared config", action: "edit", gated: true }, { id: "s2", text: "Run tests", action: "test" }]);
    expect(plan.proposals).toEqual(["s1"]);
  });

  it("a revision that hides a gated step from proposals does not verify, even if re-signed", async () => {
    const { plan } = await posted();
    const forged = { ...plan, proposals: ["s4"] };
    const { digest: _d, ...body } = forged;
    void _d;
    forged.digest = await planDigest(body);
    const receipt = await issueReceipt(HMAC, { entity_id: forged.entity_id, session_hash: forged.digest, tool: "plan", outcome: forged.status, ts: forged.ts });
    expect(await verifyPlanRevision(HMAC, forged, receipt)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Comments become revisions in the chain (P7)
// ---------------------------------------------------------------------------

describe("plan: inline comments become revisions", () => {
  it("a comment anchored to a step and line is a new sealed revision chained to the last", async () => {
    const r0 = await posted();
    const r1 = await commentOnPlan(HMAC, r0.plan, r0.receipt, { employeeId: EMP, step_id: "s1", line: 2, text: "Also list the error paths", ts: 1_700_000_100 });
    expect(r1.plan.revision).toBe(1);
    expect(r1.plan.prev_digest).toBe(r0.plan.digest);
    expect(r1.plan.root).toBe(await nextRoot(r0.plan.root, r1.plan.event));
    expect(r1.plan.comments).toEqual([{ id: "c1", step_id: "s1", line: 2, text: "Also list the error paths", by: EMP, ts: 1_700_000_100 }]);
    expect(r1.plan.open_comments).toEqual(["c1"]);
    expect(await verifyPlanRevision(HMAC, r1.plan, r1.receipt)).toBe(true);
  });

  it("revision 0's root starts from the plan genesis", async () => {
    const r0 = await posted();
    expect(r0.plan.root).toBe(await nextRoot(await genesis(ENT, "plan/T3.07"), r0.plan.event));
  });

  it("refuses a comment on an unknown step or out-of-range line", async () => {
    const r0 = await posted();
    expect(await refuses(commentOnPlan(HMAC, r0.plan, r0.receipt, { employeeId: EMP, step_id: "s9", text: "x" }))).toBe(true);
    expect(await refuses(commentOnPlan(HMAC, r0.plan, r0.receipt, { employeeId: EMP, step_id: "s1", line: 3, text: "x" }))).toBe(true);
    expect(await refuses(commentOnPlan(HMAC, r0.plan, r0.receipt, { employeeId: EMP, step_id: "s1", text: "" }))).toBe(true);
  });

  it("refuses to extend a revision that does not verify", async () => {
    const r0 = await posted();
    const tampered = { ...r0.plan, summary: "something else" };
    expect(await refuses(commentOnPlan(HMAC, tampered, r0.receipt, { employeeId: EMP, step_id: "s1", text: "x" }))).toBe(true);
    expect(await refuses(commentOnPlan(HMAC, r0.plan, "f".repeat(64), { employeeId: EMP, step_id: "s1", text: "x" }))).toBe(true);
  });

  it("a revision answers comments and recomputes proposals from the new steps", async () => {
    const r0 = await posted();
    const r1 = await commentOnPlan(HMAC, r0.plan, r0.receipt, { employeeId: EMP, step_id: "s5", text: "Do not send it, just draft it", ts: 1_700_000_100 });
    const steps = STEPS.map((s) => (s.id === "s5" ? { ...s, text: "Draft the release note for me to send", action: "draft" } : s));
    const r2 = await revisePlan(HMAC, r1.plan, r1.receipt, { entityId: ENT, steps, answers: ["c1"], ts: 1_700_000_200 });
    expect(r2.plan.revision).toBe(2);
    expect(r2.plan.open_comments).toEqual([]);
    expect(r2.plan.proposals).toEqual(["s4"]);
    expect(r2.plan.comments.length).toBe(1);
  });

  it("refuses a revision answering a comment that is not open", async () => {
    const r0 = await posted();
    expect(await refuses(revisePlan(HMAC, r0.plan, r0.receipt, { entityId: ENT, answers: ["c1"] }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 4: who may do what (P6)
// ---------------------------------------------------------------------------

describe("plan: comments and Proceed come from the employee, revisions from the agent", () => {
  it("P6: refuses a comment or Proceed signed as the agent", async () => {
    const r0 = await posted();
    expect(await refuses(commentOnPlan(HMAC, r0.plan, r0.receipt, { employeeId: ENT, step_id: "s1", text: "lgtm" }))).toBe(true);
    expect(await refuses(proceedPlan(HMAC, r0.plan, r0.receipt, { employeeId: ENT, seen_digest: r0.plan.digest }))).toBe(true);
    expect(await refuses(proceedPlan(HMAC, r0.plan, r0.receipt, { employeeId: "emp-002", seen_digest: r0.plan.digest }))).toBe(true);
  });

  it("refuses a revision signed as the employee", async () => {
    const r0 = await posted();
    expect(await refuses(revisePlan(HMAC, r0.plan, r0.receipt, { entityId: EMP }))).toBe(true);
  });

  it("the harness catalog offers post and revise, never comment or Proceed", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.includes("soul.plan_post")).toBe(true);
    expect(names.includes("soul.plan_revise")).toBe(true);
    expect(names.some((n) => /comment|proceed/i.test(n))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 5: Proceed binds to the revision seen, with every comment answered (P4, P5)
// ---------------------------------------------------------------------------

describe("plan: Proceed", () => {
  it("P4: refuses a stale Proceed after the plan changed", async () => {
    const r0 = await posted();
    const r1 = await revisePlan(HMAC, r0.plan, r0.receipt, { entityId: ENT, summary: "Changed after you looked", ts: 1_700_000_100 });
    expect(await refuses(proceedPlan(HMAC, r1.plan, r1.receipt, { employeeId: EMP, seen_digest: r0.plan.digest }))).toBe(true);
    const ok = await proceedPlan(HMAC, r1.plan, r1.receipt, { employeeId: EMP, seen_digest: r1.plan.digest });
    expect(ok.plan.status).toBe("proceeded");
  });

  it("P5: refuses Proceed while a comment is unanswered", async () => {
    const r0 = await posted();
    const r1 = await commentOnPlan(HMAC, r0.plan, r0.receipt, { employeeId: EMP, step_id: "s2", text: "Which file?", ts: 1_700_000_100 });
    expect(await refuses(proceedPlan(HMAC, r1.plan, r1.receipt, { employeeId: EMP, seen_digest: r1.plan.digest }))).toBe(true);
    const r2 = await revisePlan(HMAC, r1.plan, r1.receipt, { entityId: ENT, answers: ["c1"], ts: 1_700_000_200 });
    const ok = await proceedPlan(HMAC, r2.plan, r2.receipt, { employeeId: EMP, seen_digest: r2.plan.digest });
    expect(ok.plan.status).toBe("proceeded");
  });

  it("a proceeded plan is frozen", async () => {
    const r0 = await posted();
    const p = await proceedPlan(HMAC, r0.plan, r0.receipt, { employeeId: EMP, seen_digest: r0.plan.digest });
    expect(await refuses(commentOnPlan(HMAC, p.plan, p.receipt, { employeeId: EMP, step_id: "s1", text: "wait" }))).toBe(true);
    expect(await refuses(revisePlan(HMAC, p.plan, p.receipt, { entityId: ENT }))).toBe(true);
    expect(await refuses(proceedPlan(HMAC, p.plan, p.receipt, { employeeId: EMP, seen_digest: p.plan.digest }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 6: Proceed releases only ungated steps (P3)
// ---------------------------------------------------------------------------

describe("plan: release", () => {
  it("P3: Proceed releases the ungated steps and never a gated one", async () => {
    const r0 = await posted();
    const { plan, release } = await proceedPlan(HMAC, r0.plan, r0.receipt, { employeeId: EMP, seen_digest: r0.plan.digest });
    expect(release.released).toEqual(["s1", "s2", "s3"]);
    expect(release.proposals.map((c) => c.step_id)).toEqual(["s4", "s5"]);
    expect(mayExecute(plan, "s2")).toBe(true);
    expect(mayExecute(plan, "s4")).toBe(false);
    expect(mayExecute(plan, "s5")).toBe(false);
  });

  it("nothing is released before Proceed", async () => {
    const r0 = await posted();
    expect(releasedSteps(r0.plan)).toEqual([]);
    expect(mayExecute(r0.plan, "s1")).toBe(false);
  });

  it("a plan of only gated steps releases nothing on Proceed", async () => {
    const r0 = await posted([{ id: "s1", text: "Merge the PR", action: "merge" }]);
    const { release } = await proceedPlan(HMAC, r0.plan, r0.receipt, { employeeId: EMP, seen_digest: r0.plan.digest });
    expect(release.released).toEqual([]);
    expect(release.proposals.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Whole history verification (P7)
// ---------------------------------------------------------------------------

describe("plan: history verification", () => {
  async function fullHistory() {
    const r0 = await posted();
    const r1 = await commentOnPlan(HMAC, r0.plan, r0.receipt, { employeeId: EMP, step_id: "s3", line: 1, text: "Include the mutation run", ts: 1_700_000_100 });
    const r2 = await revisePlan(HMAC, r1.plan, r1.receipt, { entityId: ENT, steps: STEPS.map((s) => (s.id === "s3" ? { ...s, text: "Run the adapter tests and the mutation run" } : s)), answers: ["c1"], ts: 1_700_000_200 });
    const r3 = await proceedPlan(HMAC, r2.plan, r2.receipt, { employeeId: EMP, seen_digest: r2.plan.digest, ts: 1_700_000_300 });
    return [r0, r1, r2, { plan: r3.plan, receipt: r3.receipt }];
  }

  it("a posted, commented, revised and proceeded plan verifies end to end", async () => {
    const h = await fullHistory();
    expect(await verifyPlanHistory(HMAC, h)).toEqual({ ok: true });
  });

  it("refuses a history with a revision dropped", async () => {
    const h = await fullHistory();
    const r = await verifyPlanHistory(HMAC, [h[0], h[2], h[3]]);
    expect(r.ok).toBe(false);
  });

  it("refuses a history with revisions reordered", async () => {
    const h = await fullHistory();
    expect((await verifyPlanHistory(HMAC, [h[1], h[0], h[2], h[3]])).ok).toBe(false);
  });

  it("refuses a history verified under another key", async () => {
    const h = await fullHistory();
    expect((await verifyPlanHistory("another-key-entirely-0123456789abcdef", h)).ok).toBe(false);
  });

  it("P7: refuses a re-signed revision whose root does not chain from the previous root", async () => {
    const h = await fullHistory();
    const p = { ...h[1].plan, root: "0".repeat(64) };
    const { digest: _d, ...body } = p;
    void _d;
    p.digest = await planDigest(body);
    const receipt = await issueReceipt(HMAC, { entity_id: p.entity_id, session_hash: p.digest, tool: "plan", outcome: p.status, ts: p.ts });
    expect(await verifyPlanRevision(HMAC, p, receipt)).toBe(true);
    const r = await verifyPlanHistory(HMAC, [h[0], { plan: p, receipt }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("revision_1_root");
  });

  it("refuses an empty history", async () => {
    expect((await verifyPlanHistory(HMAC, [])).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MCP: the agent posts and revises through the harness
// ---------------------------------------------------------------------------

describe("plan: via the MCP server", () => {
  const KEY = "test-only-hmac-key-for-plan-mcp-0123456789";

  async function call(name, args) {
    const mod = await import("../src/harness/mcp-server.js");
    const cfg = await import("../src/harness/config.js");
    const login = await import("../src/harness/login.js");
    const harness = cfg.loadHarnessConfig({
      enabled: true,
      token_ttl_sec: 3600,
      employees: [{ id: EMP, entity_id: ENT, credential: "EMP_001_KEY", grants: ["soul.*"] }],
      soul: { url: "https://soul-svc.test/mcp", secret: "SOUL_KEY", timeout_ms: 2000 }
    });
    const env = { RELAY_ENABLED: "yes", RELAY_HMAC_KEY: KEY, EMP_001_KEY: "emp-secret-001", SOUL_KEY: "soul-secret" };
    const { token } = await login.issueToken(KEY, { employeeId: EMP, entityId: ENT, ttlSec: 3600, now: 1_700_000_000_000 });
    const headers = new Headers();
    headers.set("authorization", "Bearer " + token);
    let forwarded = 0;
    const fetcher = async () => {
      forwarded++;
      return new Response("{}", { status: 200 });
    };
    const r = await mod.handleMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      env,
      { harness, headers, fetcher, env, now: () => 1_700_000_000_000, log: () => {} }
    );
    return { r, forwarded };
  }

  it("soul.plan_post seals revision 0 locally with proposals listed", async () => {
    const { r, forwarded } = await call("soul.plan_post", { task_id: "T3.07", summary: "Plan via MCP", steps: STEPS });
    expect(forwarded).toBe(0);
    expect(r.body.result.isError).toBe(false);
    const { plan, receipt } = r.body.result.structuredContent;
    expect(plan.entity_id).toBe(ENT);
    expect(plan.employee_id).toBe(EMP);
    expect(plan.proposals).toEqual(["s4", "s5"]);
    expect(await verifyPlanRevision(KEY, plan, receipt)).toBe(true);
  });

  it("soul.plan_post refuses an unmapped action", async () => {
    const { r } = await call("soul.plan_post", { task_id: "T3.07", summary: "x", steps: [{ id: "s1", text: "x", action: "tweet" }] });
    expect(r.body.result.isError).toBe(true);
  });

  it("soul.plan_revise answers a comment and returns the next revision", async () => {
    const posted = (await call("soul.plan_post", { task_id: "T3.07", summary: "Plan via MCP", steps: STEPS })).r.body.result.structuredContent;
    const c = await commentOnPlan(KEY, posted.plan, posted.receipt, { employeeId: EMP, step_id: "s2", text: "Which file?" });
    const { r } = await call("soul.plan_revise", { plan: c.plan, receipt: c.receipt, answers: ["c1"] });
    expect(r.body.result.isError).toBe(false);
    const next = r.body.result.structuredContent;
    expect(next.plan.revision).toBe(2);
    expect(next.plan.open_comments).toEqual([]);
    expect((await verifyPlanHistory(KEY, [posted, c, next])).ok).toBe(true);
  });
});
