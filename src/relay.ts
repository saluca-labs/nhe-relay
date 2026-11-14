// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// POST /v1/turn: one character turn. Every refusal is fallback:true with a short machine reason,
// so a game can always show the persona's fallback line and carry on.
// This file also holds what every route shares: the kill switch, the limits and the spend hook.

import { LIMITS, narrowed } from "./limits";
import { sanitize, screenInjection, containsUrl, checkOutput } from "./safety";
import { validateMemory, mergeMemory, type Memory } from "./memory";
import { registry, isPersonaId, systemFrame, userBlock, personaLooksSafe, type Persona } from "./personas";
import { genesis, nextRoot, isRootHex, memoryDigest, issueReceipt, checkReceipt, keyedId, issueTtsTicket, textDigest, CHAIN_VERSION, type TurnRecord } from "./chain";
import type { Rule, TakeResult } from "./limiter-core";
import { validateScene, sceneBlock, reveals, type Scene } from "./scene";
import type { RelayConfig } from "./config";
import type { FetchLike, ProviderEnv } from "./providers/types";
import { runChain, asLlm, type Attempt, type ChainDeps } from "./providers/run";
import { buildExtensions, cleanPassages, loreBlock, type Extensions } from "./extensions";
import type { Receipt } from "./extensions/types";

export interface RelayEnv extends ProviderEnv {
  RELAY_ENABLED?: string; // kill switch: anything but exactly "yes" refuses every call
  RELAY_HMAC_KEY?: string; // receipts, TTS tickets and rate-limit key hashing; missing = refusal
  GLOBAL_DAILY_CEILING?: string; // may only narrow LIMITS.globalPerDay
  SESSION_PER_MINUTE?: string;
  SESSION_PER_DAY?: string;
  IP_PER_MINUTE?: string;
  IP_PER_DAY?: string;
  SPEND_DAILY_USD?: string; // may only narrow the config's daily_usd_ceiling, e.g. "1.50"
}

export interface Deps {
  take: (rules: Rule[]) => Promise<TakeResult>;
  fetcher: FetchLike;
  log: (rec: Record<string, unknown>) => void;
  config: RelayConfig | null; // null = the config failed to load: every call refuses
  now?: () => number;
  extensions?: Extensions; // tests inject these; otherwise built from the config per request
}

export function extensionsFor(env: RelayEnv, cfg: RelayConfig, deps: Deps): Extensions {
  return deps.extensions ?? buildExtensions(cfg, env, deps.fetcher, deps.log);
}

export interface TurnResponse {
  npc_text: string;
  memory: Memory;
  state_root: string;
  receipt?: string;
  tts?: { ticket: string; exp: number };
  citations?: { id: string; source: string; notice?: string }[];
  fallback: boolean;
  reason?: string;
  chain?: { prev: string; turn: TurnRecord };
  meta: { provider: string | null; kind: string | null; model: string | null; ms: number; attempts?: number; knowledge?: string };
}

export const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function limitRules(env: RelayEnv, ipId: string, sessionId: string): Rule[] | null {
  const g = narrowed("globalPerDay", env.GLOBAL_DAILY_CEILING);
  const sm = narrowed("sessionPerMinute", env.SESSION_PER_MINUTE);
  const sd = narrowed("sessionPerDay", env.SESSION_PER_DAY);
  const im = narrowed("ipPerMinute", env.IP_PER_MINUTE);
  const id = narrowed("ipPerDay", env.IP_PER_DAY);
  if (g === null || sm === null || sd === null || im === null || id === null) return null;
  return [
    { key: "global_day", limit: g, windowSec: 86_400 },
    { key: `ip_day:${ipId}`, limit: id, windowSec: 86_400 },
    { key: `ip_minute:${ipId}`, limit: im, windowSec: 60 },
    { key: `session_day:${sessionId}`, limit: sd, windowSec: 86_400 },
    { key: `session_minute:${sessionId}`, limit: sm, windowSec: 60 },
  ];
}

/**
 * The daily spend ceiling in micro-dollars: the config's value, narrowed by SPEND_DAILY_USD when
 * set. A malformed or larger env value is null (cannot tell), and the caller refuses.
 */
export function spendCeilingMicros(env: RelayEnv, cfg: RelayConfig): number | null {
  const raw = env.SPEND_DAILY_USD;
  if (raw === undefined || raw === "") return cfg.spendCeilingMicros;
  if (!/^[0-9]{1,4}(?:\.[0-9]{1,2})?$/.test(raw)) return null;
  const v = Math.round(Number(raw) * 1_000_000);
  if (v <= 0 || v > cfg.spendCeilingMicros) return null;
  return v;
}

/** The cost-ceiling hook every provider call goes through: one atomic, weighted take. */
export function spendHook(env: RelayEnv, cfg: RelayConfig, deps: Deps): ((micros: number) => Promise<boolean>) | null {
  const ceiling = spendCeilingMicros(env, cfg);
  if (ceiling === null) return null;
  return async (micros) => {
    const r = await deps.take([{ key: "spend_day", limit: ceiling, windowSec: 86_400, weight: micros }]);
    return r.ok;
  };
}

export function chainDeps(env: RelayEnv, cfg: RelayConfig, deps: Deps, budgetMs: number, route: "turn" | "judge" | "stt" | "tts", personaId: string | null): ChainDeps | null {
  const spend = spendHook(env, cfg, deps);
  if (!spend) return null;
  const { policy } = extensionsFor(env, cfg, deps);
  return {
    env,
    fetcher: deps.fetcher,
    spend,
    now: deps.now ?? Date.now,
    budgetMs,
    policy: (p) => policy.decide({ route, persona_id: personaId, ...p }),
  };
}

/**
 * Shared by every provider-calling route: per-session, per-IP and global limits in one atomic
 * take, plus any extra rules the route needs. Unknown configuration or an unreachable limiter is
 * a refusal. Returns null when admitted.
 */
export async function admit(env: RelayEnv, deps: Deps, ip: string, session: string, extra: Rule[] = []): Promise<{ reason: string; status: number } | null> {
  const ipId = await keyedId(env.RELAY_HMAC_KEY!, "ip", ip || "unknown");
  const sessionId = await keyedId(env.RELAY_HMAC_KEY!, "session", session);
  const rules = limitRules(env, ipId, sessionId);
  if (!rules) return { reason: "config_unreadable", status: 200 };
  let taken: TakeResult;
  try {
    taken = await deps.take([...rules, ...extra]);
  } catch {
    return { reason: "limiter_unreachable", status: 200 };
  }
  if (!taken.ok) return { reason: taken.refused === "global_day" ? "global_ceiling" : `rate_${taken.refused}`, status: 429 };
  return null;
}

/** Kill switch, key and config, in that order. Returns the refusal reason, or null when on. */
export function switchedOff(env: RelayEnv, deps: Deps): string | null {
  if (env.RELAY_ENABLED !== "yes") return "kill_switch";
  if (!env.RELAY_HMAC_KEY || env.RELAY_HMAC_KEY.length < 32) return "config_unreadable";
  if (!deps.config) return "config_unreadable";
  return null;
}

export function attemptsLog(a: Attempt[]): string[] {
  return a.map((x) => `${x.id}:${x.outcome}`);
}

interface Parsed {
  persona: Persona;
  session_id: string;
  player_text: string;
  memory: Memory;
  state_root: string;
  receipt: unknown;
  scene: Scene | null;
}

type Step<T> = { ok: true; value: T } | { ok: false; status: number; reason: string; persona?: Persona };

async function parseRequest(body: unknown): Promise<Step<Parsed>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, status: 400, reason: "body_type" };
  const b = body as Record<string, unknown>;
  const allowed = new Set(["persona_id", "session_id", "player_text", "memory", "state_root", "receipt", "scene"]);
  // A client can never send a persona, a system prompt, a model or any other field.
  for (const k of Object.keys(b)) if (!allowed.has(k)) return { ok: false, status: 400, reason: "unknown_field" };

  if (!isPersonaId(b.persona_id)) return { ok: false, status: 400, reason: "persona_id" };
  const persona = registry().get(b.persona_id);
  if (!persona) return { ok: false, status: 404, reason: "unknown_persona" };
  if (!personaLooksSafe(persona)) return { ok: false, status: 500, reason: "persona_unsafe", persona };

  if (typeof b.session_id !== "string" || !SESSION_RE.test(b.session_id)) return { ok: false, status: 400, reason: "session_id", persona };
  if (typeof b.player_text !== "string") return { ok: false, status: 400, reason: "player_text_type", persona };
  if (b.player_text.length > LIMITS.maxPlayerText * 2) return { ok: false, status: 400, reason: "player_text_size", persona };
  const player_text = sanitize(b.player_text);
  if (player_text.length === 0) return { ok: false, status: 400, reason: "player_text_empty", persona };
  if (player_text.length > LIMITS.maxPlayerText) return { ok: false, status: 400, reason: "player_text_size", persona };

  const mv = validateMemory(b.memory);
  if (!mv.ok) return { ok: false, status: 400, reason: mv.reason, persona };
  if (!isRootHex(b.state_root)) return { ok: false, status: 400, reason: "state_root_format", persona };

  const sv = validateScene(b.scene);
  if (!sv.ok) return { ok: false, status: 400, reason: sv.reason, persona };

  return { ok: true, value: { persona, session_id: b.session_id, player_text, memory: mv.memory, state_root: b.state_root, receipt: b.receipt, scene: sv.scene } };
}

function refusal(reason: string, persona: Persona | undefined, memory: Memory | undefined, root: string | undefined, receipt: unknown, ms: number): TurnResponse {
  return {
    npc_text: persona?.fallback_line ?? "",
    memory: memory ?? { summary: "", facts: [], turn_count: 0 },
    state_root: root ?? "",
    ...(typeof receipt === "string" && /^[0-9a-f]{64}$/.test(receipt) ? { receipt } : {}),
    fallback: true,
    reason,
    meta: { provider: null, kind: null, model: null, ms },
  };
}

/** Parse the model's JSON reply. Tolerates a fenced block; anything else is a failure. */
export function parseReply(text: string): { say: string; remember: unknown; summary: unknown } | null {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1];
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    const j = JSON.parse(t.slice(first, last + 1)) as Record<string, unknown>;
    if (typeof j.say !== "string") return null;
    return { say: j.say, remember: j.remember, summary: j.summary };
  } catch {
    return null;
  }
}

export async function handleTurn(body: unknown, ip: string, env: RelayEnv, deps: Deps): Promise<{ status: number; body: TurnResponse }> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const done = (status: number, r: TurnResponse, extra: Record<string, unknown> = {}) => {
    deps.log({ evt: "turn", status, fallback: r.fallback, reason: r.reason ?? null, provider: r.meta.provider, model: r.meta.model, ms: now() - t0, ...extra });
    return { status, body: r };
  };

  // 1. Kill switch first: nothing else is read while it is on.
  if (env.RELAY_ENABLED !== "yes") {
    const p = typeof body === "object" && body !== null && isPersonaId((body as Record<string, unknown>).persona_id) ? registry().get((body as { persona_id: string }).persona_id) : undefined;
    return done(200, refusal("kill_switch", p, undefined, undefined, undefined, 0));
  }
  const off = switchedOff(env, deps);
  if (off) return done(200, refusal(off, undefined, undefined, undefined, undefined, 0));
  const cfg = deps.config!;
  const key = env.RELAY_HMAC_KEY!;

  // 2. Shape, bounds, persona.
  const parsed = await parseRequest(body);
  if (!parsed.ok) return done(parsed.status, refusal(parsed.reason, parsed.persona, undefined, undefined, undefined, now() - t0));
  const req = parsed.value;
  const keep = (reason: string, status = 200) => done(status, refusal(reason, req.persona, req.memory, req.state_root, req.receipt, now() - t0));

  // 3. Limits, counted on every well-formed attempt (screened ones included).
  const limited = await admit(env, deps, ip, req.session_id);
  if (limited) return keep(limited.reason, limited.status);

  // 4. Chain fields the relay can check: genesis on the first turn, the receipt afterwards.
  const memDigest = await memoryDigest({ summary: req.memory.summary, facts: req.memory.facts, turn_count: req.memory.turn_count });
  if (req.memory.turn_count === 0) {
    if (req.memory.summary !== "" || req.memory.facts.length !== 0) return keep("chain_genesis_memory", 400);
    if (req.state_root !== (await genesis(req.persona.id, req.session_id))) return keep("chain_genesis", 400);
  } else {
    const valid = await checkReceipt(key, { persona_id: req.persona.id, session_id: req.session_id, state_root: req.state_root, turn_count: req.memory.turn_count, memory_sha256: memDigest }, req.receipt);
    if (!valid) return keep("chain_receipt", 400);
  }

  // 5. Injection screen on the player's words.
  if (screenInjection(req.player_text) || containsUrl(req.player_text)) return keep("screened");

  // 6. Grounding, when a knowledge provider is configured. Retrieved text is untrusted data:
  //    cleaned, screened and filtered against must_not_reveal before the model sees it. A failed
  //    retrieval means no lore this turn, never a guess.
  const ext = extensionsFor(env, cfg, deps);
  let passages: { id: string; source: string; text: string; notice?: string }[] = [];
  let knowledgeState = cfg.knowledge.kind === "none" ? "none" : "ok";
  if (cfg.knowledge.kind !== "none") {
    try {
      const raw = await ext.knowledge.retrieve({ persona_id: req.persona.id, query: req.player_text, k: cfg.knowledge.k });
      passages = cleanPassages(Array.isArray(raw) ? raw : [], req.scene?.must_not_reveal ?? [], cfg.knowledge.k);
    } catch {
      knowledgeState = "unavailable";
    }
  }

  // 7. Model, through the configured chain: each call asked of the policy and reserved against
  //    the spend ceiling.
  const cd = chainDeps(env, cfg, deps, cfg.turnBudgetMs, "turn", req.persona.id);
  if (!cd) return keep("config_unreadable");
  const frame = systemFrame(req.persona);
  const result = await runChain(
    cfg.llm.map(asLlm),
    { system: frame, user: (req.scene ? sceneBlock(req.scene) + "\n" : "") + loreBlock(passages) + userBlock(req.memory, req.player_text), maxOutputTokens: cfg.maxOutputTokens },
    cd,
    (t) => parseReply(t) !== null,
  );
  if (!result.ok || result.value === undefined) {
    const allSpend = result.attempts.length > 0 && result.attempts.every((a) => a.outcome === "spend_ceiling");
    const r = refusal(allSpend ? "spend_ceiling" : "model_unavailable", req.persona, req.memory, req.state_root, req.receipt, now() - t0);
    r.meta.attempts = result.attempts.length;
    return done(allSpend ? 429 : 200, r, { attempts: attemptsLog(result.attempts) });
  }

  // 8. Output check.
  const reply = parseReply(result.value);
  if (!reply) return keep("output_shape");
  const verdict = checkOutput(reply.say, frame, req.persona.max_reply_chars);
  if (!verdict.ok) return keep(verdict.reason);
  if (req.scene && reveals(verdict.text, req.scene.must_not_reveal)) return keep("output_reveals");

  // 9. New memory, new root, new receipt, and a TTS ticket for exactly this checked text.
  const memory = mergeMemory(req.memory, reply.summary, reply.remember);
  const newDigest = await memoryDigest({ summary: memory.summary, facts: memory.facts, turn_count: memory.turn_count });
  const turn: TurnRecord = {
    v: CHAIN_VERSION,
    persona_id: req.persona.id,
    session_id: req.session_id,
    turn_index: memory.turn_count,
    player_text: req.player_text,
    npc_text: verdict.text,
    memory_sha256: newDigest,
    scene_sha256: req.scene ? await memoryDigest(req.scene) : null,
    knowledge_sha256: passages.length ? await memoryDigest(passages.map((p) => ({ id: p.id, source: p.source, text: p.text, notice: p.notice ?? null }))) : null,
  };
  const state_root = await nextRoot(req.state_root, turn);
  const receipt = await issueReceipt(key, { persona_id: req.persona.id, session_id: req.session_id, state_root, turn_count: memory.turn_count, memory_sha256: newDigest });
  const exp = Math.floor(now() / 1000) + LIMITS.ttsTicketTtlSec;
  const ticket = await issueTtsTicket(key, { persona_id: req.persona.id, session_id: req.session_id, state_root, text_sha256: await textDigest(verdict.text), exp });

  // 10. The receipt goes to the sink and the policy. Neither can change or block the reply: the
  //     client already holds the receipt. A failure is logged, by kind only.
  const rec: Receipt = {
    kind: "turn",
    persona_id: req.persona.id,
    session_hash: await keyedId(key, "session", req.session_id),
    turn_index: memory.turn_count,
    prev_root: req.state_root,
    state_root,
    receipt,
    provider: result.provider?.id ?? null,
    model: result.provider?.model ?? null,
    ms: now() - t0,
  };
  const sinks: [string, () => Promise<void>][] = [
    ["receipts", () => ext.receipts.emit(rec)],
    ["policy", () => ext.policy.onReceipt(rec)],
  ];
  for (const [name, f] of sinks) {
    try {
      await f();
    } catch (e) {
      deps.log({ evt: "receipt_sink_failed", sink: name, kind: e instanceof Error ? e.name : "unknown" });
    }
  }

  return done(200, {
    npc_text: verdict.text,
    memory,
    state_root,
    receipt,
    tts: { ticket, exp },
    ...(passages.length ? { citations: passages.map((p) => ({ id: p.id, source: p.source, ...(p.notice ? { notice: p.notice } : {}) })) } : {}),
    fallback: false,
    chain: { prev: req.state_root, turn },
    meta: { provider: result.provider?.id ?? null, kind: result.provider?.kind ?? null, model: result.provider?.model ?? null, ms: now() - t0, attempts: result.attempts.length, knowledge: knowledgeState },
  }, { player_chars: req.player_text.length, npc_chars: verdict.text.length, turn_index: memory.turn_count });
}
