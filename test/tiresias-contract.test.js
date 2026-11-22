// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// T2.11: the relay speaks tiresias.enterprise.decision/v2 exactly and fails closed. The golden
// pairs and schema are vendored byte-for-byte from salucallc/tiresias-zt at the commit in
// contracts/tiresias-enterprise-decision/PIN.json (tools/check-contract-pin.mjs guards drift).
// Every golden case is replayed as a stubbed Tiresias answer and the relay's action must equal
// the case's caller_must. A contract change on either side turns this red.
//
// v2 (2026-11-21): the relay authenticates with its relay credential (Authorization: Bearer tzr_...),
// never the Tiresias platform admin key. Cases that present the credential to OTHER Tiresias
// endpoints (request.endpoint) describe what Tiresias refuses; the relay only ever calls the decision
// endpoint, so those cases are checked for that fact rather than replayed.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, it, expect } from "./expect.js";
import { loadHarnessConfig, HarnessConfigError } from "../src/harness/config.js";
import { handleMcp, handleLogin } from "../src/harness/mcp-server.js";
import { validate } from "./support/jschema.js";
import { TEST_RELAY_CREDENTIAL, freshRelayCredential } from "./support/relay-credential.js";

const DIR = new URL("../contracts/tiresias-enterprise-decision/", import.meta.url);
const read = rel => readFileSync(new URL(rel, DIR));
const SCHEMA = JSON.parse(read("v2/schema.json"));
const GOLDEN = JSON.parse(read("v2/golden.json"));
const PIN = JSON.parse(read("PIN.json"));

const HMAC = "test-only-hmac-key-0123456789abcdef0123456789";
const NOW = 1_700_000_000_000;
const TURL = "https://tiresias.test/cp/enterprise/decision";
const CONTRACT = "tiresias.enterprise.decision/v2";
const DECISION_PATH = "/cp/enterprise/decision";
const DECISION_CASES = GOLDEN.cases.filter(c => !c.request || (c.request.endpoint ?? DECISION_PATH) === DECISION_PATH);

function cfg() {
  return {
    enabled: true,
    employees: [{ id: "agent-007", entity_id: "acme-ent", credential: "EMP_KEY", grants: ["soul.*", "knowledge.recall", "tiresias.policy_check"] }],
    soul: { url: "https://soul.test/mcp", secret: "SOUL_KEY" },
    tiresias: { url: TURL, secret: "TIRESIAS_RELAY_CREDENTIAL", agent: "acme", timeout_ms: 1000 }
  };
}
const env = () => ({ RELAY_ENABLED: "yes", RELAY_HMAC_KEY: HMAC, EMP_KEY: "emp-secret", SOUL_KEY: "soul-secret", TIRESIAS_RELAY_CREDENTIAL: TEST_RELAY_CREDENTIAL });

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
  it("sends its relay credential as Bearer, never X-Admin-Key, a versioned body with tool args", async () => {
    const w = world({ status: 200, body: { contract: CONTRACT, decision: "allow" } });
    const r = await call(w, "soul.memory_search", { query: "tea", k: 2 });
    expect(r.body.result.isError).toBe(false);
    const t = w.calls.find(c => c.url === TURL);
    expect(t.init.headers.authorization).toBe(`Bearer ${TEST_RELAY_CREDENTIAL}`);
    expect(Object.keys(t.init.headers).some(h => h.toLowerCase() === "x-admin-key")).toBe(false);
    expect(validate(SCHEMA, { $ref: "#/$defs/relay_credential" }, TEST_RELAY_CREDENTIAL)).toEqual([]);
    expect(validate(SCHEMA, { $ref: "#/$defs/request" }, t.body)).toEqual([]);
    expect(t.body.contract).toBe(CONTRACT);
    expect(t.body.agent).toBe("acme");
    expect(t.body.acting_as).toBe("agent-007");
    expect(t.body.method).toBe("POST");
    expect(t.body.tool).toEqual({ name: "soul.memory_search", arguments: { query: "tea", k: 2 } });
    expect("intent" in t.body || "employeeId" in t.body || "entityId" in t.body).toBe(false);
  });
  it("the schema check can fail: v1, an omitted contract and an unknown field do not validate", () => {
    const bodies = Object.fromEntries(GOLDEN.cases.filter(c => c.request).map(c => [c.name, c.request.body]));
    expect(validate(SCHEMA, { $ref: "#/$defs/request" }, bodies.v1_request_is_retired).length > 0).toBe(true);
    expect(validate(SCHEMA, { $ref: "#/$defs/request" }, bodies.contract_omitted_is_v1_and_retired).length > 0).toBe(true);
    expect(validate(SCHEMA, { $ref: "#/$defs/request" }, bodies.unsupported_field).length > 0).toBe(true);
    expect(validate(SCHEMA, { $ref: "#/$defs/request" }, bodies.unsupported_contract).length > 0).toBe(true);
    expect(validate(SCHEMA, { $ref: "#/$defs/request" }, bodies.autonomous_allow)).toEqual([]);
  });
  it("a site-bound relay sends its site", async () => {
    const w = world({ status: 200, body: { contract: CONTRACT, decision: "allow" } });
    const c = cfg();
    c.tiresias.site = "site-1";
    await call(w, "soul.memory_search", { query: "q" }, loadHarnessConfig(c));
    const t = w.calls.find(x => x.url === TURL);
    expect(t.body.site).toBe("site-1");
    expect(validate(SCHEMA, { $ref: "#/$defs/request" }, t.body)).toEqual([]);
  });
});

describe("every golden case maps to the action the contract requires", () => {
  it("covers all 34 golden cases (29 decision-endpoint cases replayed)", () => {
    expect(GOLDEN.cases.length).toBe(34);
    expect(DECISION_CASES.length).toBe(29);
  });
  it("the credential the golden cases show is the one the relay holds: Bearer, never X-Admin-Key", () => {
    for (const c of GOLDEN.cases.filter(x => x.request && x.caller_must !== "refuse"))
      expect(c.request.headers.Authorization).toMatch(/^Bearer \{credential:\w+\}$/);
    const adminCases = GOLDEN.cases.filter(x => x.request && "X-Admin-Key" in x.request.headers);
    expect(adminCases.length > 0).toBe(true);
    for (const c of adminCases) expect(c.caller_must).toBe("refuse");
  });
  for (const c of DECISION_CASES) {
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
  it("200 with a wrong contract version (v1)", async () => { await refused({ status: 200, body: { contract: "tiresias.enterprise.decision/v1", decision: "allow" } }); });
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
  it("a missing relay credential in the environment refuses the call and never reaches Tiresias", async () => {
    const w = world({ status: 200, body: { contract: CONTRACT, decision: "allow" } });
    const e = env();
    const { deps } = await session(w, loadHarnessConfig(cfg()), e);
    delete deps.env.TIRESIAS_RELAY_CREDENTIAL;
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

describe("the relay never holds or sends the Tiresias admin key", () => {
  const notSent = async value => {
    const w = world({ status: 200, body: { contract: CONTRACT, decision: "allow" } });
    const e = { ...env(), TIRESIAS_RELAY_CREDENTIAL: value };
    const r = await call(w, "soul.memory_search", { query: "q" }, loadHarnessConfig(cfg()), e);
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toContain("tiresias_relay_credential_malformed");
    expect(w.calls.filter(c => c.url === TURL).length).toBe(0);
    expect(w.backendCalls().length).toBe(0);
  };
  it("an admin-key-shaped secret is refused before any network call", async () => { await notSent("contract-admin-key"); });
  it("a data-plane tir_ key is refused before any network call", async () => { await notSent("tir_acme_" + "ab".repeat(16)); });
  it("a near-miss credential (uppercase hex) is refused", async () => { await notSent(freshRelayCredential().toUpperCase()); });
  it("config refuses a secret variable named like an admin key", () => {
    const err = loadError(c => { c.tiresias.secret = "TIRESIAS_ADMIN_KEY"; });
    expect(err instanceof HarnessConfigError).toBe(true);
    expect(String(err.message)).toContain("admin");
  });
  it("cases that present the credential to other Tiresias endpoints are refusals the relay never makes", () => {
    const others = GOLDEN.cases.filter(c => c.request && (c.request.endpoint ?? DECISION_PATH) !== DECISION_PATH);
    expect(others.length).toBe(5);
    for (const c of others) expect(c.caller_must).toBe("refuse");
  });
});
