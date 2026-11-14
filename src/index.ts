// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Worker entry: config load, routing, CORS and the binding to the limiter Durable Object.

import { handleTurn, type RelayEnv, type Deps } from "./relay";
import { handleJudge } from "./judge";
import { handleStt, handleTts } from "./speech";
import { corsHeaders, originAllowed, type CorsPolicy } from "./cors";
import { LIMITS } from "./limits";
import { loadConfig, type RelayConfig } from "./config";
import { genesis } from "./chain";
import { registry, isPersonaId } from "./personas";
import { SESSION_RE } from "./relay";
import type { Rule, TakeResult } from "./limiter-core";
import configJson from "../relay.config.json";

export { Limiter } from "./limiter";

export const VERSION = "0.1.0";

export interface Env extends RelayEnv {
  LIMITER: DurableObjectNamespace<import("./limiter").Limiter>;
}

let cached: { config: RelayConfig | null; error: string | null } | null = null;

/** Load once per isolate. A config that fails to load is null, and every call refuses. */
export function currentConfig(raw: unknown = configJson): { config: RelayConfig | null; error: string | null } {
  if (cached && raw === configJson) return cached;
  let out: { config: RelayConfig | null; error: string | null };
  try {
    out = { config: loadConfig(raw), error: null };
  } catch (e) {
    out = { config: null, error: e instanceof Error ? e.message.slice(0, 200) : "config" };
  }
  if (raw === configJson) cached = out;
  return out;
}

function json(status: number, body: unknown, origin: string | null, cors: CorsPolicy | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders(origin, cors) },
  });
}

function log(rec: Record<string, unknown>): void {
  // Structured, and never the player's text, a transcript or the session id: counts,
  // latencies, provider, reason.
  console.log(JSON.stringify({ svc: "nhe-relay", v: VERSION, ...rec }));
}

async function readCapped(request: Request, cap: number): Promise<Uint8Array | null> {
  const len = request.headers.get("content-length");
  if (len !== null && Number(len) > cap) return null;
  const buf = new Uint8Array(await request.arrayBuffer());
  return buf.length > cap ? null : buf;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const { config, error } = currentConfig();
    const cors = config ? config.cors : null;

    if (origin !== null && (!cors || !originAllowed(origin, cors))) {
      log({ evt: "cors_refused" });
      return json(403, { fallback: true, reason: "origin" }, null, null);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin, cors) });

    if (url.pathname === "/health" && request.method === "GET") {
      return json(200, { ok: config !== null, service: "nhe-relay", version: VERSION, enabled: env.RELAY_ENABLED === "yes", config: error ? "unreadable" : "ok" }, origin, cors);
    }

    const ip = request.headers.get("cf-connecting-ip") ?? "";
    // The limiter stub is made on first use, so a refused request never touches the Durable Object.
    let stub: { take(rules: Rule[]): Promise<unknown> } | null = null;
    const deps: Deps = {
      take: (rules: Rule[]) => {
        stub ??= env.LIMITER.get(env.LIMITER.idFromName("global"));
        return stub.take(rules) as Promise<TakeResult>;
      },
      fetcher: (u, init) => fetch(u, init),
      log,
      config,
    };
    if (error) log({ evt: "config_unreadable", detail: error });

    // GET /v1/genesis: the first state root for (persona, session), so a client without SHA-256
    // (an engine plugin, a shell script) can start a chain. Pure computation, no provider call.
    if (url.pathname === "/v1/genesis" && request.method === "GET") {
      const p = url.searchParams.get("persona_id");
      const s = url.searchParams.get("session_id");
      if (!isPersonaId(p) || !registry().has(p)) return json(404, { reason: "unknown_persona" }, origin, cors);
      if (s === null || !SESSION_RE.test(s)) return json(400, { reason: "session_id" }, origin, cors);
      return json(200, { state_root: await genesis(p, s) }, origin, cors);
    }

    if (url.pathname === "/v1/stt" && request.method === "POST") {
      const audio = await readCapped(request, LIMITS.maxAudioBytes);
      if (!audio) return json(413, { fallback: true, reason: "audio_size" }, origin, cors);
      const r = await handleStt(audio, request.headers.get("content-type") ?? "", url.searchParams.get("session_id"), ip, env, deps);
      return json(r.status, r.body, origin, cors);
    }

    const route = url.pathname === "/v1/turn" ? "turn" : url.pathname === "/v1/judge" ? "judge" : url.pathname === "/v1/tts" ? "tts" : null;
    if (route && request.method === "POST") {
      const raw = await readCapped(request, LIMITS.maxBodyBytes);
      if (!raw) return json(413, { fallback: true, reason: "body_size" }, origin, cors);
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return json(400, { fallback: true, reason: "body_json" }, origin, cors);
      }
      if (route === "tts") {
        const r = await handleTts(body, ip, env, deps);
        if (r.kind === "refusal") return json(r.status, r.body, origin, cors);
        return new Response(r.audio.audio, {
          status: 200,
          headers: { "content-type": r.audio.contentType, "cache-control": "no-store", "x-nhe-provider": r.meta.provider ?? "", "x-nhe-fallback": "false", ...corsHeaders(origin, cors) },
        });
      }
      const r = route === "turn" ? await handleTurn(body, ip, env, deps) : await handleJudge(body, ip, env, deps);
      return json(r.status, r.body, origin, cors);
    }

    return json(404, { fallback: true, reason: "not_found" }, origin, cors);
  },
} satisfies ExportedHandler<Env>;
