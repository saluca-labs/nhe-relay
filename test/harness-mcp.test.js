// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

import { describe, it, expect } from "./expect.js";
import { handleLogin, handleMcp } from "../src/harness/mcp-server.js";
import { loadHarnessConfig } from "../src/harness/config.js";
import { issueToken } from "../src/harness/login.js";
import { TOOLS, toolNames, findTool, PROTOCOL_VERSION } from "../src/harness/tools.js";

const HMAC = "test-only-hmac-key-0123456789abcdef0123456789";
const NOW = 1_700_000_000_000;

function harnessConfig(over = {}) {
  return loadHarnessConfig({
    enabled: true,
    token_ttl_sec: 3600,
    employees: [
      { id: "emp-001", entity_id: "agent-emp-001", credential: "EMP_001_KEY" }
    ],
    soul: { url: "https://soul-svc.test/mcp", secret: "SOUL_KEY", timeout_ms: 2000 },
    knowledge: { url: "https://kb.test/mcp", secret: "KB_KEY", timeout_ms: 2000, k: 3 },
    tiresias: { url: "https://tiresias.test/api", secret: "TIRESIAS_KEY", timeout_ms: 1000 },
    ...over
  });
}

function env(over = {}) {
  return { RELAY_ENABLED: "yes", RELAY_HMAC_KEY: HMAC, EMP_001_KEY: "emp-secret-001", SOUL_KEY: "soul-secret", KB_KEY: "kb-secret", TIRESIAS_KEY: "tiresias-secret", ...over };
}

function deps(over = {}) {
  return {
    harness: harnessConfig(),
    headers: new Headers(),
    fetcher: async () => new Response("{}", { status: 200 }),
    env: env(),
    now: () => NOW,
    log: () => {},
    ...over
  };
}

describe("tool catalog", () => {
  it("exposes 12 tools across soul, knowledge and tiresias backends", () => {
    expect(TOOLS.length).toBe(12);
    const names = toolNames();
    expect(names).toContain("soul.session_init");
    expect(names).toContain("soul.memory_search");
    expect(names).toContain("soul.memory_write");
    expect(names).toContain("soul.identity");
    expect(names).toContain("soul.walkthrough");
    expect(names).toContain("soul.plan_post");
    expect(names).toContain("soul.plan_revise");
    expect(names).toContain("knowledge.recall");
    expect(names).toContain("soul.workspace_create");
    expect(names).toContain("soul.workspace_reuse");
    expect(names).toContain("soul.workspace_clean");
    expect(names).toContain("tiresias.policy_check");
  });

  it("each tool has a name, description and inputSchema", () => {
    for (const t of TOOLS) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(typeof t.inputSchema).toBe("object");
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("findTool returns the tool or undefined", () => {
    expect(findTool("soul.memory_search").name).toBe("soul.memory_search");
    expect(findTool("nonexistent")).toBeUndefined();
  });
});

describe("login endpoint", () => {
  it("issues a token for a valid employee credential", async () => {
    const r = await handleLogin(
      { employee_id: "emp-001", credential: "emp-secret-001" },
      env(),
      { harness: harnessConfig(), now: () => NOW }
    );
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(r.body.entity_id).toBe("agent-emp-001");
  });

  it("rejects an unknown employee", async () => {
    const r = await handleLogin(
      { employee_id: "emp-999", credential: "x" },
      env(),
      { harness: harnessConfig(), now: () => NOW }
    );
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("unknown_employee");
  });

  it("rejects a wrong credential", async () => {
    const r = await handleLogin(
      { employee_id: "emp-001", credential: "wrong" },
      env(),
      { harness: harnessConfig(), now: () => NOW }
    );
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("invalid_credential");
  });

  it("refuses when harness is disabled", async () => {
    const r = await handleLogin(
      { employee_id: "emp-001", credential: "emp-secret-001" },
      env(),
      { harness: null, now: () => NOW }
    );
    expect(r.status).toBe(503);
  });
});

describe("MCP server: initialize", () => {
  it("responds to initialize with protocol version and server info", async () => {
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1.0" } } },
      env(),
      deps()
    );
    expect(r.status).toBe(200);
    expect(r.body.jsonrpc).toBe("2.0");
    expect(r.body.id).toBe(1);
    expect(r.body.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(r.body.result.serverInfo.name).toBe("nhe-relay");
  });

  it("responds 202 to notifications/initialized", async () => {
    const r = await handleMcp(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      env(),
      deps()
    );
    expect(r.status).toBe(202);
    expect(r.body).toBeNull();
  });

  it("refuses when harness is disabled", async () => {
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      env(),
      deps({ harness: null })
    );
    expect(r.status).toBe(503);
  });
});

describe("MCP server: tools/list", () => {
  it("returns the tool catalog when authenticated", async () => {
    const { token } = await issueToken(HMAC, { employeeId: "emp-001", entityId: "agent-emp-001", ttlSec: 3600, now: NOW });
    const h = new Headers({ authorization: "Bearer " + token });
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      env(),
      deps({ headers: h })
    );
    expect(r.status).toBe(200);
    expect(r.body.result.tools.length).toBe(12);
    expect(r.body.result.tools[0].name).toBe("soul.session_init");
  });

  it("rejects tools/list without a bearer token", async () => {
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      env(),
      deps({ headers: new Headers() })
    );
    expect(r.status).toBe(401);
  });

  it("rejects tools/list with an invalid bearer token", async () => {
    const h = new Headers({ authorization: "Bearer invalid-token-here" });
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      env(),
      deps({ headers: h })
    );
    expect(r.status).toBe(401);
  });
});

describe("MCP server: tools/call", () => {
  async function authDeps(over = {}) {
    const { token } = await issueToken(HMAC, { employeeId: "emp-001", entityId: "agent-emp-001", ttlSec: 3600, now: NOW });
    const h = new Headers({ authorization: "Bearer " + token });
    return deps({ headers: h, ...over });
  }

  it("calls soul.memory_search and returns structured content with a receipt", async () => {
    const soulResp = JSON.stringify({
      jsonrpc: "2.0", id: 1,
      result: {
        isError: false,
        content: [{ type: "text", text: "Found 2 memories." }],
        structuredContent: { passages: [{ text: "Employee likes tea.", source: "memory", id: "mem:1" }] }
      }
    });
    const fetcher = async (url) => {
      if (url === "https://soul-svc.test/mcp") return new Response(soulResp, { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://tiresias.test/api") return new Response(JSON.stringify({ allow: true }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200 });
    };
    const d = await authDeps({ fetcher });
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "soul.memory_search", arguments: { query: "preferences" } } },
      env(),
      d
    );
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(false);
    expect(r.body.result.structuredContent.passages[0].text).toBe("Employee likes tea.");
    expect(r.body.result._meta.receipt).toMatch(/^[0-9a-f]{64}$/);
  });

  it("calls knowledge.recall and returns passages with a receipt", async () => {
    const kbResp = JSON.stringify({
      jsonrpc: "2.0", id: 1,
      result: {
        isError: false,
        content: [{ type: "text", text: "Results." }],
        structuredContent: { passages: [{ text: "Company policy on remote work.", source: "handbook", id: "kb:1" }] }
      }
    });
    const fetcher = async (url) => {
      if (url === "https://kb.test/mcp") return new Response(kbResp, { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://tiresias.test/api") return new Response(JSON.stringify({ allow: true }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200 });
    };
    const d = await authDeps({ fetcher });
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "knowledge.recall", arguments: { query: "remote work" } } },
      env(),
      d
    );
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(false);
    expect(r.body.result.structuredContent.passages.length).toBe(1);
    expect(r.body.result._meta.receipt).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns an error result when Tiresias denies the call", async () => {
    const fetcher = async (url) => {
      if (url === "https://tiresias.test/api") return new Response(JSON.stringify({ allow: false, reason: "spend_cap_exceeded" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200 });
    };
    const d = await authDeps({ fetcher });
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "soul.memory_search", arguments: { query: "test" } } },
      env(),
      d
    );
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toContain("spend_cap_exceeded");
    expect(r.body.result._meta.receipt).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns an error for an unknown tool name", async () => {
    const d = await authDeps();
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nonexistent.tool", arguments: {} } },
      env(),
      d
    );
    expect(r.body.error.code).toBe(-32602);
    expect(r.body.error.message).toContain("unknown tool");
  });

  it("rejects tools/call without authentication", async () => {
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "soul.memory_search", arguments: {} } },
      env(),
      deps({ headers: new Headers() })
    );
    expect(r.status).toBe(401);
  });

  it("returns method_not_found for an unknown RPC method", async () => {
    const d = await authDeps();
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 8, method: "resources/list" },
      env(),
      d
    );
    expect(r.body.error.code).toBe(-32601);
  });

  it("every successful call includes a receipt (D20)", async () => {
    const soulResp = JSON.stringify({
      jsonrpc: "2.0", id: 1,
      result: { isError: false, content: [{ type: "text", text: "ok" }] }
    });
    const fetcher = async (url) => {
      if (url === "https://soul-svc.test/mcp") return new Response(soulResp, { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://tiresias.test/api") return new Response(JSON.stringify({ allow: true }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200 });
    };
    const d = await authDeps({ fetcher });
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "soul.identity", arguments: {} } },
      env(),
      d
    );
    expect(r.body.result._meta.receipt).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("harness config validation", () => {
  it("returns null when harness section is absent", () => {
    expect(loadHarnessConfig(undefined)).toBeNull();
  });

  it("rejects an empty employees array", () => {
    expect(() => loadHarnessConfig({ enabled: true, employees: [] })).toThrow();
  });

  it("rejects a duplicate employee id", () => {
    expect(() => loadHarnessConfig({
      enabled: true,
      employees: [
        { id: "emp-001", entity_id: "agent-001", credential: "EMP_001_KEY" },
        { id: "emp-001", entity_id: "agent-002", credential: "EMP_002_KEY" }
      ],
      soul: { url: "https://soul.test/mcp", secret: "SOUL_KEY" }
    })).toThrow();
  });

  it("rejects an unknown field", () => {
    expect(() => loadHarnessConfig({
      enabled: true,
      employees: [{ id: "emp-001", entity_id: "agent-001", credential: "EMP_001_KEY" }],
      bogus: true
    })).toThrow();
  });

  it("requires soul backend when enabled", () => {
    expect(() => loadHarnessConfig({
      enabled: true,
      employees: [{ id: "emp-001", entity_id: "agent-001", credential: "EMP_001_KEY" }]
    })).toThrow();
  });

  it("accepts a disabled harness without soul", () => {
    const c = loadHarnessConfig({
      enabled: false,
      employees: [{ id: "emp-001", entity_id: "agent-001", credential: "EMP_001_KEY" }]
    });
    expect(c.enabled).toBe(false);
    expect(c.soul).toBeNull();
  });
});
