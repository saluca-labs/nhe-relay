// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// T2.11: the relay speaks tiresias.enterprise.decision/v1 exactly and fails closed. The golden
// pairs and schema are vendored byte-for-byte from salucallc/tiresias-zt at the commit in
// contracts/tiresias-enterprise-decision/PIN.json (tools/check-contract-pin.mjs guards drift).
// Every golden case is replayed as a stubbed Tiresias answer and the relay's action must equal
// the case's caller_must. A contract change on either side turns this red.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, it, expect } from "./expect.js";
import { loadHarnessConfig, HarnessConfigError } from "../src/harness/config.js";
import { handleMcp, handleLogin } from "../src/harness/mcp-server.js";
import { validate } from "./support/jschema.js";

const DIR = new URL("../contracts/tiresias-enterprise-decision/", import.meta.url);
const read = rel => readFileSync(new URL(rel, DIR));
const SCHEMA = JSON.parse(read("v1/schema.json"));
const GOLDEN = JSON.parse(read("v1/golden.json"));
const PIN = JSON.parse(read("PIN.json"));

const HMAC = "test-only-hmac-key-0123456789abcdef0123456789";
const ADMIN_KEY = "contract-admin-key";
const NOW = 1_700_000_000_000;
const TURL = "https://tiresias.test/cp/enterprise/decision";
const CONTRACT = "tiresias.enterprise.decision/v1";

function cfg() {
  return {
    enabled: true,
    employees: [{ id: "agent-007", entity_id: "acme-ent", credential: "EMP_KEY", grants: ["soul.*", "knowledge.recall", "tiresias.policy_check"] }],
    soul: { url: "https://soul.test/mcp", secret: "SOUL_KEY" },
    tiresias: { url: TURL, secret: "TIRESIAS_ADMIN_KEY", agent: "acme", timeout_ms: 1000 }
  };
}
const env = () => ({ RELAY_ENABLED: "yes", RELAY_HMAC_KEY: HMAC, EMP_KEY: "emp-secret", SOUL_KEY: "soul-secret", TIRESIAS_ADMIN_KEY: ADMIN_KEY });

const soulOk = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: false, content: [{ type: "text", text: "ok" }], structuredContent: { passages: [] } } });

/** A fetcher that records calls and answers Tiresias from `answer` ({status, body}) or throws. */
function world(answer) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : undefined });
    if (url === TURL) {
      if (answer === "unreachable") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { "content-type": "application/json" } });
    }
    return new Response(soulOk, { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetcher, calls, backendCalls: () => calls.filter(c => c.url !== TURL) };
}

async function session(w, harness, e = env()) {
  const deps = { harness, headers: new Headers(), fetcher: w.fetcher, env: e, now: () => NOW, log: () => {} };
  const login = await handleLogin({ employee_id: "agent-007", credential: "emp-secret" }, e, deps);
  deps.headers = new Headers({ authorization: `Bearer ${login.body.token}` });
  return { deps, e };
}

async function call(w, tool = "soul.memory_search", args = { query: "q" }, harness = loadHarnessConfig(cfg()), e = env()) {
  const { deps } = await session(w, harness, e);
  return handleMcp({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: tool, arguments: args } }, e, deps);
}

function loadError(mutate) {
  const c = cfg();
  mutate(c);
  try { loadHarnessConfig(c); } catch (e) { return e; }
  return undefined;
}

describe("vendored contract is pinned, not hand-edited", () => {
  it("each vendored file hashes to the PIN", () => {
    for (const [rel, meta] of Object.entries(PIN.files))
      expect(createHash("sha256").update(read(rel)).digest("hex")).toBe(meta.sha256);
    expect(PIN.source_commit).toMatch(/^[0-9a-f]{40}$/);
  });
  it("the contract id in the fixture is the one the relay speaks", () => {
    expect(GOLDEN.contract).toBe(CONTRACT);
    expect(SCHEMA.$defs.contract.const).toBe(CONTRACT);
  });
});

describe("the relay request validates against the schema", () => {
  it("sends X-Admin-Key, no Authorization, a versioned body with tool args", async () => {
    const w = world({ status: 200, body: { contract: CONTRACT, decision: "allow" } });
    const r = await call(w, "soul.memory_search", { query: "tea", k: 2 });
    expect(r.body.result.isError).toBe(false);
    const t = w.calls.find(c => c.url === TURL);
    expect(t.init.headers["X-Admin-Key"]).toBe(ADMIN_KEY);
    expect(t.init.headers.authorization).toBeUndefined();
    expect(t.init.headers.Authorization).toBeUndefined();
    expect(validate(SCHEMA, { $ref: "#/$defs/request" }, t.body)).toEqual([]);
    expect(t.body.contract).toBe(CONTRACT);
    expect(t.body.agent).toBe("acme");
    expect(t.body.acting_as).toBe("agent-007");
    expect(t.body.method).toBe("POST");
    expect(t.body.tool).toEqual({ name: "soul.memory_search", arguments: { query: "tea", k: 2 } });
    expect("intent" in t.body || "employeeId" in t.body || "entityId" in t.body).toBe(false);
  });
  it("the schema check can fail: the pre-contract body and an unsupported contract do not validate", () => {
    const bodies = Object.fromEntries(GOLDEN.cases.filter(c => c.request).map(c => [c.name, c.request.body]));
    expect(validate(SCHEMA, { $ref: "#/$defs/request" }, bodies.pre_contract_relay_body).length > 0).toBe(true);
    expect(validate(SCHEMA, { $ref: "#/$defs/request" }, bodies.unsupported_contract).length > 0).toBe(true);
    expect(validate(SCHEMA, { $ref: "#/$defs/request" }, bodies.autonomous_allow)).toEqual([]);
  });
});

describe("every golden case maps to the action the contract requires", () => {
  it("covers all 17 golden cases", () => { expect(GOLDEN.cases.length).toBe(17); });
  for (const c of GOLDEN.cases) {
    it(`${c.name} -> ${c.caller_must}`, async () => {
      // expect.body is a SUBSET of the real response (golden.json description); the schema requires
      // `contract` on every 200 body, so a stub for a 200 case carries it. Error bodies are used as given.
      const w = world(c.name === "tiresias_unreachable" ? "unreachable"
        : { status: c.expect.status, body: c.expect.status === 200 ? { contract: CONTRACT, ...c.expect.body } : c.expect.body });
      const r = await call(w);
      const res = r.body.result;
      if (c.caller_must === "proceed") {
        expect(res.isError).toBe(false);
        expect(w.backendCalls().length).toBe(1);
      } else {
        // request_approval and refuse both mean: the backend is not called.
        expect(res.isError).toBe(true);
        expect(w.backendCalls().length).toBe(0);
        if (c.caller_must === "request_approval") expect(res.content[0].text).toContain("Approval required");
      }
    });
  }
});

describe("answers the relay must refuse", () => {
  const refused = async answer => {
    const w = world(answer);
    const r = await call(w);
    expect(r.body.result.isError).toBe(true);
    expect(w.backendCalls().length).toBe(0);
  };
  it("the old shape {allow:true} is not an allow", async () => { await refused({ status: 200, body: { allow: true } }); });
  it("200 with a wrong contract version", async () => { await refused({ status: 200, body: { contract: "tiresias.enterprise.decision/v2", decision: "allow" } }); });
  it("200 with an unknown decision value", async () => { await refused({ status: 200, body: { contract: CONTRACT, decision: "maybe" } }); });
  it("200 with a non-object body", async () => { await refused({ status: 200, body: "allow" }); });
  it("non-200 even when the body says allow", async () => { await refused({ status: 403, body: { contract: CONTRACT, decision: "allow" } }); });
});

describe("fail closed when Tiresias is not configured", () => {
  it("config load refuses enabled:true without a tiresias block", () => {
    const err = loadError(c => { delete c.tiresias; });
    expect(err instanceof HarnessConfigError).toBe(true);
    expect(String(err.message)).toContain("harness.tiresias");
  });
  it("a harness built without tiresias (bypassing config) still refuses every call", async () => {
    const w = world({ status: 200, body: { contract: CONTRACT, decision: "allow" } });
    const harness = { ...loadHarnessConfig(cfg()), tiresias: null };
    const r = await call(w, "soul.memory_search", { query: "q" }, harness);
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toContain("tiresias_not_configured");
    expect(w.backendCalls().length).toBe(0);
  });
  it("a missing admin key in the environment refuses the call and never reaches Tiresias", async () => {
    const w = world({ status: 200, body: { contract: CONTRACT, decision: "allow" } });
    const e = env();
    const { deps } = await session(w, loadHarnessConfig(cfg()), e);
    delete deps.env.TIRESIAS_ADMIN_KEY;
    const r = await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "soul.memory_search", arguments: { query: "q" } } }, e, deps);
    expect(r.body.result.isError).toBe(true);
    expect(w.calls.filter(c => c.url === TURL).length).toBe(0);
    expect(w.backendCalls().length).toBe(0);
  });
  it("tiresias.policy_check with no tiresias never answers allow", async () => {
    const w = world({ status: 200, body: { contract: CONTRACT, decision: "allow" } });
    const harness = { ...loadHarnessConfig(cfg()), tiresias: null };
    const r = await call(w, "tiresias.policy_check", { intent: "tool_call" }, harness);
    expect(r.body.result.isError).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('"allow":true');
  });
});

describe("explicit grants only", () => {
  it("an employee with no grants list fails the config load", () => {
    const err = loadError(c => { delete c.employees[0].grants; });
    expect(err instanceof HarnessConfigError).toBe(true);
    expect(String(err.message)).toContain("grants");
  });
  it("a bare * grant is refused at config load", () => {
    const err = loadError(c => { c.employees[0].grants = ["*"]; });
    expect(err instanceof HarnessConfigError).toBe(true);
  });
  it("a tiresias block without an agent slug fails the config load", () => {
    const err = loadError(c => { delete c.tiresias.agent; });
    expect(err instanceof HarnessConfigError).toBe(true);
  });
});
