// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// The MCP route must not pass the incoming request's headers on (merge gate SEC-5), and the
// employee's own Authorization, Cookie and X-* credential headers must never reach an upstream.

import { describe, it, expect } from "./expect.js";
import { readFileSync, readdirSync } from "node:fs";
import { handleMcp, authOnlyHeaders } from "../src/harness/mcp-server.js";
import { loadHarnessConfig } from "../src/harness/config.js";
import { issueToken } from "../src/harness/login.js";

const HMAC = "test-only-hmac-key-0123456789abcdef0123456789";
const NOW = 1_700_000_000_000;
const here = (p) => new URL(p, import.meta.url);

function planted(token) {
  return new Headers({
    authorization: `Bearer ${token}`,
    cookie: "session=PLANTED-COOKIE",
    "x-api-key": "PLANTED-API-KEY",
    "x-forwarded-for": "203.0.113.9",
    "content-type": "application/json"
  });
}

describe("authOnlyHeaders", () => {
  it("keeps the bearer needed for local verification and drops everything else", () => {
    const out = authOnlyHeaders(planted("tok"));
    expect(out).toEqual({ authorization: "Bearer tok" });
    expect(Object.keys(out).length).toBe(1);
  });
  it("returns an empty object when there is no bearer or no headers", () => {
    expect(Object.keys(authOnlyHeaders(new Headers())).length).toBe(0);
    expect(Object.keys(authOnlyHeaders(undefined)).length).toBe(0);
  });
  it("is a plain object, not the request's Headers instance", () => {
    const h = planted("tok");
    expect(authOnlyHeaders(h) === h).toBe(false);
    expect(authOnlyHeaders(h) instanceof Headers).toBe(false);
  });
});

describe("worker wiring", () => {
  it("src/index.js passes the MCP handler the allowlisted headers, never request.headers", () => {
    const src = readFileSync(here("../src/index.js"), "utf8");
    // the merge gate's own SEC-5 pattern for JavaScript
    expect(/headers\s*:\s*(\{\s*\.\.\.\s*)?(req|request|ctx\.request|c\.req|event\.request)\.(headers|raw\.headers)\b/.test(src)).toBe(false);
    expect(src.includes("headers: authOnlyHeaders(request.headers)")).toBe(true);
  });
});

describe("planted credentials do not reach an upstream", () => {
  it("a tools/call with a planted Authorization, Cookie and X-Api-Key sends none of them upstream", async () => {
    const harness = loadHarnessConfig({
      enabled: true,
      token_ttl_sec: 3600,
      employees: [{ id: "emp-001", entity_id: "agent-emp-001", credential: "EMP_001_KEY", grants: ["soul.*", "knowledge.*", "tiresias.*"] }],
      soul: { url: "https://soul-svc.test/mcp", secret: "SOUL_KEY", timeout_ms: 2000 },
      tiresias: { url: "https://tiresias.test/api", secret: "TIRESIAS_KEY", agent: "acme", timeout_ms: 1000 }
    });
    const env = { RELAY_ENABLED: "yes", RELAY_HMAC_KEY: HMAC, EMP_001_KEY: "emp-secret-001", SOUL_KEY: "soul-secret", TIRESIAS_KEY: "tiresias-secret" };
    const { token } = await issueToken(HMAC, { employeeId: "emp-001", entityId: "agent-emp-001", ttlSec: 3600, now: NOW });
    const seen = [];
    const fetcher = async (url, init) => {
      seen.push({ url, headers: init?.headers ?? {} });
      return new Response(JSON.stringify({ contract: "tiresias.enterprise.decision/v1", decision: "allow" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const incoming = planted(token);
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "soul.memory_search", arguments: { query: "x" } } },
      env,
      { harness, headers: authOnlyHeaders(incoming), fetcher, env, now: () => NOW, log: () => {} }
    );
    expect(r.status).toBe(200);
    expect(seen.length > 0).toBe(true);
    for (const call of seen) {
      const all = JSON.stringify(call.headers).toLowerCase();
      expect(all.includes("planted-cookie")).toBe(false);
      expect(all.includes("planted-api-key")).toBe(false);
      expect(all.includes("203.0.113.9")).toBe(false);
      expect(all.includes(token.toLowerCase())).toBe(false);
    }
  });
});

describe("harness config templates", () => {
  it("every examples/harness/*.json is valid JSON", () => {
    const dir = here("../examples/harness/");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length > 0).toBe(true);
    for (const f of files) {
      let ok = true;
      try { JSON.parse(readFileSync(new URL(f, dir), "utf8")); } catch { ok = false; }
      expect(ok).toBe(true);
    }
  });
});
