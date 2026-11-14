// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// A generic MCP retriever: calls one tool on a remote MCP server over the Streamable HTTP
// transport (JSON-RPC 2.0 over POST) and turns its result into passages.
//
// Per call: initialize, notifications/initialized, then tools/call, carrying the server's
// Mcp-Session-Id header when it sends one. A reply may be plain JSON or a text/event-stream;
// both are read. The URL is fixed in the config (https only); the key is a secret NAME.
//
// Result mapping, in order:
//   1. structuredContent.passages (or .results): items with text, and optional id (or
//      entry_hash), source and notice;
//   2. otherwise every text content block becomes one passage.

import { ProviderError, type CallContext } from "../providers/types";
import { timedFetch, optionalSecret } from "../providers/http";
import type { KnowledgeProvider, Passage } from "./types";

export interface McpRetrieverEntry {
  kind: string;
  url: string;
  secret?: string;
  authScheme: "bearer" | "header";
  authHeader: string; // used when authScheme is "header", for example "x-api-key"
  tool: string;
  queryArg: string;
  kArg: string | null;
  personaArg: string | null; // pass the persona id under this argument name, when set
  fixedArgs: Record<string, string>; // for example {"mindset": "museum-history"}
  personaArgs: Record<string, Record<string, string>>; // per persona id, merged over fixedArgs
  sourceLabel: string;
  timeoutMs: number;
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Parse a JSON-RPC reply that may be JSON or SSE; return the message with the wanted id. */
export async function readRpc(r: Response, id: number): Promise<Record<string, unknown>> {
  const text = await r.text();
  const type = r.headers.get("content-type") ?? "";
  const candidates: string[] = [];
  if (type.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) if (line.startsWith("data:")) candidates.push(line.slice(5).trim());
  } else {
    candidates.push(text);
  }
  for (const c of candidates) {
    let m: unknown;
    try {
      m = JSON.parse(c);
    } catch {
      continue;
    }
    for (const x of Array.isArray(m) ? m : [m]) {
      if (typeof x === "object" && x !== null && (x as { id?: unknown }).id === id) return x as Record<string, unknown>;
    }
  }
  throw new ProviderError("bad_response", "rpc_shape");
}

export function passagesFrom(result: unknown, label: string): Passage[] {
  const r = result as { structuredContent?: Record<string, unknown>; content?: unknown; isError?: unknown };
  if (r?.isError === true) throw new ProviderError("upstream", "tool_error");
  const sc = r?.structuredContent;
  const list = (sc && (Array.isArray(sc.passages) ? sc.passages : Array.isArray(sc.results) ? sc.results : null)) as unknown[] | null;
  const out: Passage[] = [];
  if (list) {
    list.forEach((x, i) => {
      const e = x as Record<string, unknown>;
      const text = typeof e.text === "string" ? e.text : typeof e.content === "string" ? e.content : null;
      if (!text) return;
      const id = typeof e.id === "string" ? e.id : typeof e.entry_hash === "string" ? `${label}:${e.entry_hash.slice(0, 16)}` : `${label}:${i + 1}`;
      out.push({ id, source: typeof e.source === "string" ? e.source : label, text, ...(typeof e.notice === "string" && e.notice ? { notice: e.notice } : {}) });
    });
    return out;
  }
  if (Array.isArray(r?.content)) {
    r.content.forEach((b: unknown, i: number) => {
      const blk = b as { type?: unknown; text?: unknown };
      if (blk.type === "text" && typeof blk.text === "string" && blk.text.trim()) out.push({ id: `${label}:${i + 1}`, source: label, text: blk.text });
    });
    return out;
  }
  throw new ProviderError("bad_response", "tool_shape");
}

export function mcpRetriever(e: McpRetrieverEntry, ctxFor: () => CallContext): KnowledgeProvider {
  return {
    kind: e.kind,
    async retrieve(req) {
      const ctx = ctxFor();
      const key = optionalSecret(ctx, e.secret);
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      if (key) {
        if (e.authScheme === "bearer") headers.authorization = `Bearer ${key}`;
        else headers[e.authHeader] = key;
      }
      const post = async (msg: Record<string, unknown>, session: string | null) =>
        timedFetch(ctx, e.url, {
          method: "POST",
          headers: { ...headers, ...(session ? { "mcp-session-id": session, "mcp-protocol-version": MCP_PROTOCOL_VERSION } : {}) },
          body: JSON.stringify(msg),
        });

      const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "nhe-relay", version: "0.1.0" } } }, null);
      const session = init.headers.get("mcp-session-id");
      const initMsg = await readRpc(init, 1);
      if (initMsg.error) throw new ProviderError("upstream", "initialize");
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);

      const args: Record<string, unknown> = { ...e.fixedArgs, ...(e.personaArgs[req.persona_id] ?? {}), [e.queryArg]: req.query };
      if (e.kArg) args[e.kArg] = req.k;
      if (e.personaArg) args[e.personaArg] = req.persona_id;
      const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: e.tool, arguments: args } }, session);
      const msg = await readRpc(call, 2);
      if (msg.error) throw new ProviderError("upstream", "tools_call");
      return passagesFrom(msg.result, e.sourceLabel).slice(0, req.k);
    },
  };
}
