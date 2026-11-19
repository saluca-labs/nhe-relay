// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// The relay as an MCP server (Streamable HTTP transport, JSON-RPC 2.0 over POST).
// Harnesses (Claude Code, OpenCode, Codex, Cursor) connect here, authenticate with a bearer
// token from /v1/login, and call tools that broker soul-svc, Asphodel knowledge and Tiresias.
//
// Every tools/call is:
//   1. Authenticated: the bearer token resolves to an employee and entity identity.
//   2. Policy-checked: Tiresias decides allow or deny before the backend is called.
//   3. Grant-checked: the employee's grants must authorise the requested tool.
//   4. Receipted: the relay issues a chained receipt (HMAC over the call), per D20.
//
// Methods: initialize, notifications/initialized, tools/list, tools/call.

import { issueToken, verifyToken, extractBearer } from "./login.js";
import { TOOLS, findTool, PROTOCOL_VERSION } from "./tools.js";
import { findEmployee } from "./config.js";
import { hasGrant } from "./grants.js";
import { keyedId, issueReceipt } from "../chain.js";
import { createWalkthrough } from "./walkthrough.js";

const SERVER_INFO = { name: "nhe-relay", version: "0.1.0" };
const SERVER_CAPS = { tools: { listChanged: false } };

/**
 * The only incoming header the MCP route needs: the employee's bearer, read here to verify it
 * locally. It is returned as a plain object holding that one header and nothing else, so the
 * incoming request's Cookie, X-* credential headers and the like never travel further, and
 * the employee's bearer is never forwarded upstream (the relay authenticates upstream with its
 * own credential). An explicit allowlist of one, not a copy of the request's headers.
 * @param {Headers | undefined} incoming
 * @param {string} [name]
 */
export function authOnlyHeaders(incoming, name = "authorization") {
  const value = incoming?.get?.(name);
  return value ? { [name]: value } : {};
}

/**
 * Handle POST /v1/login.
 * Body: { employee_id, credential }
 * The credential is the value of the env var named in the employee config entry.
 * Returns: { token, entity_id, exp } or { error: reason }.
 */
export async function handleLogin(body, env, deps) {
  const harness = deps.harness;
  if (!harness || !harness.enabled)
    return { status: 503, body: { error: "harness_disabled" } };

  if (typeof body !== "object" || body === null)
    return { status: 400, body: { error: "body_type" } };

  const empId = body.employee_id;
  const credential = body.credential;
  if (typeof empId !== "string" || typeof credential !== "string")
    return { status: 400, body: { error: "credentials" } };

  const emp = findEmployee(harness, empId);
  if (!emp)
    return { status: 403, body: { error: "unknown_employee" } };

  const expected = env[emp.credential];
  if (typeof expected !== "string" || expected.length === 0)
    return { status: 503, body: { error: "credential_not_configured" } };

  if (credential !== expected)
    return { status: 403, body: { error: "invalid_credential" } };

  const { token, exp } = await issueToken(env.RELAY_HMAC_KEY, {
    employeeId: emp.id,
    entityId: emp.entityId,
    ttlSec: harness.tokenTtlSec,
    now: deps.now ? deps.now() : undefined
  });

  return { status: 200, body: { token, entity_id: emp.entityId, exp } };
}

/**
 * Handle POST /mcp (Streamable HTTP transport).
 * The request is a JSON-RPC 2.0 message. The Authorization header carries the bearer token
 * for all methods except initialize (which is unauthenticated, per the MCP spec).
 *
 * Returns a JSON-RPC response object, or a { status, body } error envelope.
 */
export async function handleMcp(request, env, deps) {
  const harness = deps.harness;
  if (!harness || !harness.enabled)
    return { status: 503, body: { jsonrpc: "2.0", error: { code: -32600, message: "harness_disabled" } } };

  let rpc;
  try {
    rpc = typeof request === "string" ? JSON.parse(request) : request;
  } catch {
    return { status: 400, body: { jsonrpc: "2.0", error: { code: -32700, message: "parse_error" } } };
  }

  if (typeof rpc !== "object" || rpc === null || rpc.jsonrpc !== "2.0")
    return { status: 400, body: { jsonrpc: "2.0", error: { code: -32600, message: "invalid_request" } } };

  const id = rpc.id;
  const method = rpc.method;

  // notifications have no id and get a 202
  if (id === undefined || id === null) {
    if (method === "notifications/initialized")
      return { status: 202, body: null };
    return { status: 400, body: { jsonrpc: "2.0", error: { code: -32600, message: "notifications must omit id" } } };
  }

  // initialize is unauthenticated (the client has no token yet)
  if (method === "initialize") {
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: SERVER_CAPS,
          serverInfo: SERVER_INFO
        }
      }
    };
  }

  // all other methods require a valid bearer token
  const authHeader = deps.authHeader ?? "authorization";
  const token = extractBearer(deps.headers?.get?.(authHeader) ?? deps.headers?.[authHeader] ?? "");
  const identity = token ? await verifyToken(env.RELAY_HMAC_KEY, token, deps.now ? deps.now() : undefined) : null;
  if (!identity)
    return { status: 401, body: { jsonrpc: "2.0", id, error: { code: -32001, message: "unauthorized" } } };

  if (method === "tools/list") {
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          }))
        }
      }
    };
  }

  if (method === "tools/call") {
    return await handleToolCall(rpc, env, deps, identity, harness);
  }

  return { status: 200, body: { jsonrpc: "2.0", id, error: { code: -32601, message: "method_not_found" } } };
}

/**
 * Dispatch a tools/call to the right backend, after a Tiresias policy check and with a receipt.
 */
async function handleToolCall(rpc, env, deps, identity, harness) {
  const id = rpc.id;
  const params = rpc.params;
  if (typeof params !== "object" || params === null) {
    return { status: 200, body: { jsonrpc: "2.0", id, error: { code: -32602, message: "invalid_params" } } };
  }
  const toolName = params.name;
  const args = params.arguments ?? {};
  const tool = findTool(toolName);
  if (!tool) {
    return { status: 200, body: { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${toolName}` } } };
  }

  // 1. Policy check: Tiresias decides before the backend is called.
  const policyDecision = await checkPolicy(deps, harness, {
    intent: "tool_call",
    tool: toolName,
    employeeId: identity.employeeId,
    entityId: identity.entityId
  });
  if (!policyDecision.allow) {
    const receipt = await receiptFor(env, deps, identity, toolName, "denied");
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Policy denied: ${policyDecision.reason}` }],
          _meta: { receipt }
        }
      }
    };
  }

  // 1b. Grant check: the employee's grants must authorise this tool.
  const emp = findEmployee(harness, identity.employeeId);
  if (!emp || !hasGrant(emp.grants, toolName)) {
    const receipt = await receiptFor(env, deps, identity, toolName, "denied");
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: "Grant denied: employee lacks grant for " + toolName }],
          _meta: { receipt }
        }
      }
    };
  }

  // 2. Dispatch to the backend.
  let result;
  try {
    result = await dispatchTool(toolName, args, env, deps, identity, harness);
  } catch (e) {
    const receipt = await receiptFor(env, deps, identity, toolName, "error");
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Backend error: ${e instanceof Error ? e.message : "unknown"}` }],
          _meta: { receipt }
        }
      }
    };
  }

  // 3. Receipt: every turn is receipted (D20).
  const receipt = await receiptFor(env, deps, identity, toolName, "ok");

  if (result.structuredContent) {
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          isError: false,
          content: [{ type: "text", text: JSON.stringify(result.structuredContent) }],
          structuredContent: result.structuredContent,
          _meta: { receipt }
        }
      }
    };
  }

  return {
    status: 200,
    body: {
      jsonrpc: "2.0",
      id,
      result: {
        isError: false,
        content: result.content ?? [{ type: "text", text: JSON.stringify(result) }],
        _meta: { receipt }
      }
    }
  };
}

/**
 * Check policy via Tiresias. If no Tiresias backend is configured, the built-in policy allows
 * (the relay guards already ran). A Tiresias that cannot be reached is a deny.
 */
async function checkPolicy(deps, harness, req) {
  if (!harness.tiresias) {
    return { allow: true };
  }
  try {
    const cfg = harness.tiresias;
    const headers = { "content-type": "application/json" };
    const key = deps.env[cfg.secret];
    if (key) headers.authorization = `Bearer ${key}`;
    const resp = await deps.fetcher(cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(cfg.timeoutMs)
    });
    if (!resp.ok) return { allow: false, reason: "tiresias_error" };
    const body = await resp.json();
    if (body.allow === true) return { allow: true };
    return { allow: false, reason: body.reason ?? "tiresias_deny" };
  } catch {
    return { allow: false, reason: "tiresias_unreachable" };
  }
}

/**
 * Issue a receipt for a tool call. The receipt is an HMAC over the tool name, the entity id,
 * and the outcome, so it is verifiable without storing content.
 */
async function receiptFor(env, deps, identity, toolName, outcome) {
  const key = env.RELAY_HMAC_KEY;
  const sessionHash = await keyedId(key, "harness", identity.entityId);
  const ts = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
  const receipt = await issueReceipt(key, {
    entity_id: identity.entityId,
    session_hash: sessionHash,
    tool: toolName,
    outcome,
    ts
  });
  return receipt;
}


/**
 * Handle soul.walkthrough locally (D21 item 1). Creates a sealed walkthrough artifact
 * with a digest over its content and an HMAC receipt tying it to the relay key. The
 * artifact is returned to the caller; the relay stores nothing.
 *
 * If the evidence block is empty, the outcome is forced to "no_evidence", and
 * isDone("no_evidence") is false, so a task with no evidence is never reported as done.
 */
async function handleWalkthrough(args, env, identity) {
  const hmacKey = env.RELAY_HMAC_KEY;
  if (typeof hmacKey !== "string" || hmacKey.length === 0)
    throw new Error("RELAY_HMAC_KEY not configured");

  const { artifact, receipt } = await createWalkthrough(hmacKey, {
    employeeId: identity.employeeId,
    entityId: identity.entityId,
    task_id: args.task_id,
    summary: args.summary,
    files_touched: args.files_touched,
    command_output: args.command_output,
    turn_receipts: args.turn_receipts,
    requested_outcome: args.requested_outcome
  });

  return {
    structuredContent: { artifact, receipt },
    content: [{ type: "text", text: JSON.stringify({ artifact, receipt }) }]
  };
}

/**
 * Dispatch a tool call to the configured backend. Each backend is reached over HTTP.
 * The relay proxies to soul-svc (its MCP endpoint) or Asphodel (its MCP endpoint).
 * For tiresias.policy_check, the relay calls the Tiresias policy API directly.
 */
async function dispatchTool(toolName, args, env, deps, identity, harness) {
  // soul.walkthrough is handled locally: the relay seals the artifact into its own
  // chain. It is not forwarded to soul-svc, because the walkthrough is about the
  // relay's chain, not the soul backend.
  if (toolName === "soul.walkthrough") {
    return await handleWalkthrough(args, env, identity);
  }
  if (toolName.startsWith("soul.")) {
    return await callSoulBackend(toolName, args, env, deps, identity, harness);
  }
  if (toolName.startsWith("knowledge.")) {
    return await callKnowledgeBackend(toolName, args, env, deps, identity, harness);
  }
  if (toolName === "tiresias.policy_check") {
    return await callTiresiasDirect(args, env, deps, identity, harness);
  }
  throw new Error(`no dispatcher for ${toolName}`);
}

async function callSoulBackend(toolName, args, env, deps, identity, harness) {
  const cfg = harness.soul;
  if (!cfg) throw new Error("soul backend not configured");
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const key = env[cfg.secret];
  if (key) headers.authorization = `Bearer ${key}`;

  // Map the relay tool to the soul-svc MCP tool.
  const soulTool = toolName.replace("soul.", "");
  const soulArgs = { ...args, entity_id: identity.entityId, employee_id: identity.employeeId };

  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: soulTool, arguments: soulArgs } };
  const resp = await deps.fetcher(cfg.url, {
    method: "POST",
    headers,
    body: JSON.stringify(rpc),
    signal: AbortSignal.timeout(cfg.timeoutMs)
  });
  const text = await resp.text();
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    // try SSE
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        try { msg = JSON.parse(line.slice(5).trim()); } catch { /* skip */ }
      }
    }
  }
  if (!msg || msg.error)
    throw new Error(msg?.error?.message ?? "soul backend error");

  const r = msg.result;
  if (r?.isError === true)
    return { isError: true, content: r.content };

  // Extract structured content if present, otherwise pass through text content.
  if (r?.structuredContent)
    return { structuredContent: r.structuredContent, content: r.content };
  return { content: r?.content ?? [{ type: "text", text: JSON.stringify(r ?? {}) }] };
}

async function callKnowledgeBackend(toolName, args, env, deps, identity, harness) {
  const cfg = harness.knowledge;
  if (!cfg) throw new Error("knowledge backend not configured");
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const key = env[cfg.secret];
  if (key) headers.authorization = `Bearer ${key}`;

  // Map to the Asphodel MCP tool: recall or ask.
  const knowledgeTool = toolName.replace("knowledge.", "");
  const kArgs = { ...args, entity_id: identity.entityId };
  if (args.k === undefined) kArgs.k = cfg.k;

  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: knowledgeTool, arguments: kArgs } };
  const resp = await deps.fetcher(cfg.url, {
    method: "POST",
    headers,
    body: JSON.stringify(rpc),
    signal: AbortSignal.timeout(cfg.timeoutMs)
  });
  const text = await resp.text();
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        try { msg = JSON.parse(line.slice(5).trim()); } catch { /* skip */ }
      }
    }
  }
  if (!msg || msg.error)
    throw new Error(msg?.error?.message ?? "knowledge backend error");

  const r = msg.result;
  if (r?.structuredContent) {
    const passages = r.structuredContent.passages ?? r.structuredContent.results ?? [];
    return { structuredContent: { passages }, content: r.content };
  }
  return { content: r?.content ?? [{ type: "text", text: "No passages found." }] };
}

async function callTiresiasDirect(args, env, deps, identity, harness) {
  const cfg = harness.tiresias;
  if (!cfg) {
    return { content: [{ type: "text", text: JSON.stringify({ allow: true, reason: "no_tiresias_configured" }) }] };
  }
  const headers = { "content-type": "application/json" };
  const key = env[cfg.secret];
  if (key) headers.authorization = `Bearer ${key}`;

  const resp = await deps.fetcher(cfg.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      intent: args.intent,
      model: args.model,
      employee_id: identity.employeeId,
      entity_id: identity.entityId
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs)
  });
  const body = await resp.json();
  return { structuredContent: body, content: [{ type: "text", text: JSON.stringify(body) }] };
}