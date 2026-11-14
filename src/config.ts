// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// relay.config.json: which providers run, in what order, at what price, with which secret NAMES.
// It is bundled with the Worker at build time. It never holds a key: a provider names a Worker
// secret (for example "ANTHROPIC_API_KEY") and the adapter reads it at call time.
//
// The whole file is validated at load. Any unknown field, unknown kind, missing price, non-https
// URL or out-of-range number fails the load, and a failed load refuses every call
// ("config_unreadable"): a half-read config is unknown, and unknown is a refusal.

import { LIMITS } from "./limits";
import type { LlmProvider, Price, SttProvider, TtsProvider } from "./providers/types";
import { workersAiLlm } from "./providers/llm/workers-ai";
import { ollamaCloudLlm } from "./providers/llm/ollama-cloud";
import { openRouterLlm } from "./providers/llm/openrouter";
import { anthropicLlm, ANTHROPIC_DEFAULT_MODEL, type Effort } from "./providers/llm/anthropic";
import { openAiCompatibleLlm } from "./providers/llm/openai-compatible";
import { workersAiStt } from "./providers/stt/workers-ai";
import { deepgramStt } from "./providers/stt/deepgram";
import { openAiCompatibleStt } from "./providers/stt/openai-compatible";
import { whisperHttpStt } from "./providers/stt/whisper-http";
import { workersAiTts } from "./providers/tts/workers-ai";
import { elevenLabsTts } from "./providers/tts/elevenlabs";
import { azureTts } from "./providers/tts/azure";
import { httpTts, type TtsShape } from "./providers/tts/http-tts";
import type { AudioFormat } from "./providers/tts/common";
import type { McpRetrieverEntry } from "./extensions/mcp";
import type { TiresiasEntry } from "./extensions/tiresias";
import type { HttpSinkEntry } from "./extensions/http-sink";

export interface RelayConfig {
  llm: LlmProvider[];
  stt: SttProvider[];
  tts: TtsProvider[];
  turnBudgetMs: number;
  maxOutputTokens: number;
  spendCeilingMicros: number;
  cors: { origins: string[]; allowLocalhost: boolean };
  policy: PolicyEntry;
  knowledge: KnowledgeEntry;
  receipts: ReceiptsEntry;
}

export type PolicyEntry = { kind: "builtin" } | ({ kind: "tiresias" } & TiresiasEntry);
export type KnowledgeEntry = { kind: "none"; k: number } | { kind: "local"; k: number } | ({ kind: "mcp"; k: number } & McpRetrieverEntry);
export type ReceiptsEntry = { kind: "log" } | ({ kind: "http" } & HttpSinkEntry);

export class ConfigError extends Error {}

type Obj = Record<string, unknown>;

function fail(where: string, what: string): never {
  throw new ConfigError(`${where}: ${what}`);
}

function obj(v: unknown, where: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(where, "not an object");
  return v as Obj;
}

function only(o: Obj, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(where, `unknown field ${k}`);
}

function str(o: Obj, k: string, where: string, re: RegExp, required = true): string | undefined {
  const v = o[k];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || !re.test(v)) fail(where, `${k} missing or malformed`);
  return v;
}

function int(o: Obj, k: string, where: string, min: number, max: number, dflt: number): number {
  const v = o[k];
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) fail(where, `${k} must be an integer from ${min} to ${max}`);
  return v;
}

function bool(o: Obj, k: string, where: string, dflt: boolean): boolean {
  const v = o[k];
  if (v === undefined) return dflt;
  if (typeof v !== "boolean") fail(where, `${k} must be true or false`);
  return v;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SECRET_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MODEL_RE = /^[A-Za-z0-9@][A-Za-z0-9@._:/-]{0,127}$/;
const VOICE_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:()-]{0,63}$/;
const HTTPS_RE = /^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%/-]*)?$/;
const REGION_RE = /^[a-z0-9]{3,32}$/;

function nonNegative(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 10_000;
}

/** A price is required for every provider. A free or flat-fee tier says so explicitly. */
function price(o: Obj, where: string, unit: "tokens" | "minutes" | "chars"): Price {
  const p = obj(o.price, `${where}.price`);
  if (p.flat === true && Object.keys(p).length === 1) return { flat: true };
  if (unit === "tokens") {
    only(p, ["input_usd_per_mtok", "output_usd_per_mtok"], `${where}.price`);
    if (!nonNegative(p.input_usd_per_mtok) || !nonNegative(p.output_usd_per_mtok)) fail(`${where}.price`, "needs input_usd_per_mtok and output_usd_per_mtok, or {\"flat\": true}");
    return { input_usd_per_mtok: p.input_usd_per_mtok, output_usd_per_mtok: p.output_usd_per_mtok };
  }
  if (unit === "minutes") {
    only(p, ["usd_per_minute"], `${where}.price`);
    if (!nonNegative(p.usd_per_minute)) fail(`${where}.price`, "needs usd_per_minute, or {\"flat\": true}");
    return { usd_per_minute: p.usd_per_minute };
  }
  only(p, ["usd_per_mchar"], `${where}.price`);
  if (!nonNegative(p.usd_per_mchar)) fail(`${where}.price`, "needs usd_per_mchar, or {\"flat\": true}");
  return { usd_per_mchar: p.usd_per_mchar };
}

function base(o: Obj, where: string, unit: "tokens" | "minutes" | "chars", defaultModel?: string) {
  const id = str(o, "id", where, ID_RE)!;
  const model = (str(o, "model", where, MODEL_RE, defaultModel === undefined) ?? defaultModel)!;
  const timeoutMs = int(o, "timeout_ms", where, 500, LIMITS.providerTimeoutMs, 4_000);
  return { id, model, timeoutMs, price: price(o, where, unit) };
}

function llmEntry(raw: unknown, i: number): LlmProvider {
  const where = `llm[${i}]`;
  const o = obj(raw, where);
  const kind = str(o, "kind", where, /^[a-z-]+$/)!;
  const common = ["id", "kind", "model", "timeout_ms", "price"];
  switch (kind) {
    case "workers-ai":
      only(o, common, where);
      return workersAiLlm({ kind, ...base(o, where, "tokens") });
    case "ollama-cloud":
      only(o, [...common, "secret"], where);
      return ollamaCloudLlm({ kind, ...base(o, where, "tokens"), secret: str(o, "secret", where, SECRET_RE)! });
    case "openrouter":
      only(o, [...common, "secret", "free_only"], where);
      return openRouterLlm({ kind, ...base(o, where, "tokens"), secret: str(o, "secret", where, SECRET_RE)!, freeOnly: bool(o, "free_only", where, true) });
    case "anthropic": {
      only(o, [...common, "secret", "effort", "max_tokens", "fallbacks"], where);
      const effort = str(o, "effort", where, /^(low|medium|high|xhigh|max)$/, false) ?? "low";
      return anthropicLlm({
        kind,
        ...base(o, where, "tokens", ANTHROPIC_DEFAULT_MODEL),
        secret: str(o, "secret", where, SECRET_RE)!,
        effort: effort as Effort,
        maxTokens: int(o, "max_tokens", where, 256, 16_000, 2_048),
        fallbacks: bool(o, "fallbacks", where, true),
      });
    }
    case "openai-compatible":
      only(o, [...common, "base_url", "secret", "json_mode"], where);
      return openAiCompatibleLlm({
        kind,
        ...base(o, where, "tokens"),
        baseUrl: str(o, "base_url", where, HTTPS_RE)!,
        secret: str(o, "secret", where, SECRET_RE, false),
        jsonMode: bool(o, "json_mode", where, true),
      });
    default:
      fail(where, `unknown llm kind ${kind}`);
  }
}

function sttEntry(raw: unknown, i: number): SttProvider {
  const where = `stt[${i}]`;
  const o = obj(raw, where);
  const kind = str(o, "kind", where, /^[a-z-]+$/)!;
  const common = ["id", "kind", "model", "timeout_ms", "price", "language"];
  const language = str(o, "language", where, /^[a-z]{2}(?:-[A-Z]{2})?$/, false);
  switch (kind) {
    case "workers-ai":
      only(o, common, where);
      return workersAiStt({ kind, ...base(o, where, "minutes"), language });
    case "deepgram":
      only(o, [...common, "secret"], where);
      return deepgramStt({ kind, ...base(o, where, "minutes"), secret: str(o, "secret", where, SECRET_RE)!, language });
    case "openai-compatible":
      only(o, [...common, "base_url", "secret"], where);
      return openAiCompatibleStt({ kind, ...base(o, where, "minutes"), baseUrl: str(o, "base_url", where, HTTPS_RE)!, secret: str(o, "secret", where, SECRET_RE, false), language });
    case "whisper-http":
      only(o, [...common, "url", "secret", "field"], where);
      return whisperHttpStt({
        kind,
        ...base(o, where, "minutes", "whisper"),
        url: str(o, "url", where, HTTPS_RE)!,
        secret: str(o, "secret", where, SECRET_RE, false),
        field: str(o, "field", where, /^[a-z_]{1,32}$/, false) ?? "file",
      });
    default:
      fail(where, `unknown stt kind ${kind}`);
  }
}

function ttsEntry(raw: unknown, i: number): TtsProvider {
  const where = `tts[${i}]`;
  const o = obj(raw, where);
  const kind = str(o, "kind", where, /^[a-z-]+$/)!;
  const common = ["id", "kind", "model", "timeout_ms", "price", "format", "voice"];
  const format = (str(o, "format", where, /^(mp3|wav)$/, false) ?? "mp3") as AudioFormat;
  const defaultVoice = str(o, "voice", where, VOICE_RE, false) ?? null;
  switch (kind) {
    case "workers-ai":
      only(o, common, where);
      return workersAiTts({ kind, ...base(o, where, "chars"), format, defaultVoice });
    case "elevenlabs":
      only(o, [...common, "secret"], where);
      return elevenLabsTts({ kind, ...base(o, where, "chars"), format, defaultVoice, secret: str(o, "secret", where, SECRET_RE)! });
    case "azure":
      only(o, [...common, "secret", "region"], where);
      return azureTts({ kind, ...base(o, where, "chars", "neural"), format, defaultVoice, secret: str(o, "secret", where, SECRET_RE)!, region: str(o, "region", where, REGION_RE)! });
    case "http":
      only(o, [...common, "url", "shape", "secret"], where);
      return httpTts({
        kind,
        ...base(o, where, "chars", "self-hosted"),
        format,
        defaultVoice,
        url: str(o, "url", where, HTTPS_RE)!,
        shape: str(o, "shape", where, /^(piper|openai-speech)$/)! as TtsShape,
        secret: str(o, "secret", where, SECRET_RE, false),
      });
    default:
      fail(where, `unknown tts kind ${kind}`);
  }
}

function list<T>(o: Obj, k: string, f: (raw: unknown, i: number) => T): T[] {
  const v = o[k];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 8) fail(k, "must be a list of at most 8 providers");
  const out = v.map(f);
  const ids = new Set<string>();
  for (const p of out as { id: string }[]) {
    if (ids.has(p.id)) fail(k, `duplicate id ${p.id}`);
    ids.add(p.id);
  }
  return out;
}

const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/;

export function loadConfig(raw: unknown): RelayConfig {
  const o = obj(raw, "config");
  only(o, ["_note", "llm", "stt", "tts", "turn_budget_ms", "max_output_tokens", "spend", "cors", "policy", "knowledge", "receipts"], "config");
  const spend = obj(o.spend, "spend");
  only(spend, ["daily_usd_ceiling"], "spend");
  const ceiling = spend.daily_usd_ceiling;
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling <= 0 || ceiling > LIMITS.spendUsdPerDay) {
    fail("spend", `daily_usd_ceiling must be above 0 and at most ${LIMITS.spendUsdPerDay}`);
  }
  const cors = obj(o.cors ?? { origins: [] }, "cors");
  only(cors, ["origins", "allow_localhost"], "cors");
  if (!Array.isArray(cors.origins) || cors.origins.length > 32 || cors.origins.some((x) => typeof x !== "string" || !ORIGIN_RE.test(x))) {
    fail("cors", "origins must be a list of https origins (scheme, host and optional port, nothing else)");
  }
  const llm = list(o, "llm", llmEntry);
  if (llm.length === 0) fail("llm", "at least one llm provider is required");
  return {
    llm,
    stt: list(o, "stt", sttEntry),
    tts: list(o, "tts", ttsEntry),
    turnBudgetMs: int(o, "turn_budget_ms", "config", 1_000, LIMITS.turnBudgetMs, 7_000),
    maxOutputTokens: int(o, "max_output_tokens", "config", 64, 4_096, 300),
    spendCeilingMicros: Math.round(ceiling * 1_000_000),
    cors: { origins: cors.origins as string[], allowLocalhost: bool(cors, "allow_localhost", "cors", true) },
    policy: policyEntry(o.policy),
    knowledge: knowledgeEntry(o.knowledge),
    receipts: receiptsEntry(o.receipts),
  };
}

const ARG_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const ASPHODEL_MCP_URL = "https://mindsets.asphodel.ai/mcp";
const HEADER_RE = /^[a-z][a-z0-9-]{1,63}$/;

function stringMap(v: unknown, where: string): Record<string, string> {
  if (v === undefined) return {};
  const o = obj(v, where);
  if (Object.keys(o).length > 16) fail(where, "at most 16 entries");
  for (const [k, x] of Object.entries(o)) {
    if (!ARG_RE.test(k) || typeof x !== "string" || x.length > 200) fail(where, `entry ${k} malformed`);
  }
  return o as Record<string, string>;
}

function policyEntry(raw: unknown): PolicyEntry {
  if (raw === undefined) return { kind: "builtin" };
  const o = obj(raw, "policy");
  const kind = o.kind;
  if (kind === "builtin") {
    only(o, ["kind"], "policy");
    return { kind: "builtin" };
  }
  if (kind === "tiresias") {
    only(o, ["kind", "url", "secret", "timeout_ms"], "policy");
    return { kind: "tiresias", url: str(o, "url", "policy", HTTPS_RE)!, secret: str(o, "secret", "policy", SECRET_RE, false), timeoutMs: int(o, "timeout_ms", "policy", 200, LIMITS.providerTimeoutMs, 1_000) };
  }
  fail("policy", `unknown policy kind ${String(kind)}`);
}

function knowledgeEntry(raw: unknown): KnowledgeEntry {
  if (raw === undefined) return { kind: "none", k: 0 };
  const o = obj(raw, "knowledge");
  const kind = o.kind;
  if (kind === "none") {
    only(o, ["kind"], "knowledge");
    return { kind: "none", k: 0 };
  }
  const k = int(o, "k", "knowledge", 1, 4, 3);
  if (kind === "local") {
    only(o, ["kind", "k"], "knowledge");
    return { kind: "local", k };
  }
  if (kind === "mcp") {
    only(o, ["kind", "k", "url", "secret", "auth_scheme", "auth_header", "tool", "query_arg", "k_arg", "persona_arg", "args", "persona_args", "source_label", "timeout_ms"], "knowledge");
    const personaArgs: Record<string, Record<string, string>> = {};
    if (o.persona_args !== undefined) {
      const pa = obj(o.persona_args, "knowledge.persona_args");
      for (const [pid, m] of Object.entries(pa)) {
        if (!ID_RE.test(pid)) fail("knowledge.persona_args", `bad persona id ${pid}`);
        personaArgs[pid] = stringMap(m, `knowledge.persona_args.${pid}`);
      }
    }
    return {
      kind: "mcp",
      k,
      url: str(o, "url", "knowledge", HTTPS_RE)!,
      secret: str(o, "secret", "knowledge", SECRET_RE, false),
      authScheme: (str(o, "auth_scheme", "knowledge", /^(bearer|header)$/, false) ?? "bearer") as "bearer" | "header",
      authHeader: str(o, "auth_header", "knowledge", HEADER_RE, false) ?? "authorization",
      tool: str(o, "tool", "knowledge", ARG_RE)!,
      queryArg: str(o, "query_arg", "knowledge", ARG_RE, false) ?? "query",
      kArg: str(o, "k_arg", "knowledge", ARG_RE, false) ?? null,
      personaArg: str(o, "persona_arg", "knowledge", ARG_RE, false) ?? null,
      fixedArgs: stringMap(o.args, "knowledge.args"),
      personaArgs,
      sourceLabel: str(o, "source_label", "knowledge", /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,39}$/, false) ?? "mcp",
      timeoutMs: int(o, "timeout_ms", "knowledge", 500, LIMITS.providerTimeoutMs, 3_000),
    };
  }
  if (kind === "asphodel") {
    // A preset over the MCP retriever for the Asphodel Mindsets partner MCP server. Optional,
    // and a commercial service: it needs a token from Asphodel, held as a Worker secret.
    only(o, ["kind", "k", "url", "secret", "mode", "mindset", "persona_mindsets", "timeout_ms"], "knowledge");
    const mode = (str(o, "mode", "knowledge", /^(recall|ask)$/, false) ?? "recall") as "recall" | "ask";
    const mindset = str(o, "mindset", "knowledge", /^[a-z0-9][a-z0-9_-]{0,63}$/, mode === "recall" && o.persona_mindsets === undefined);
    const personaArgs: Record<string, Record<string, string>> = {};
    if (o.persona_mindsets !== undefined) {
      for (const [pid, m] of Object.entries(obj(o.persona_mindsets, "knowledge.persona_mindsets"))) {
        if (!ID_RE.test(pid) || typeof m !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(m)) fail("knowledge.persona_mindsets", `entry ${pid} malformed`);
        personaArgs[pid] = { mindset: m };
      }
    }
    return {
      kind: "mcp",
      k,
      url: str(o, "url", "knowledge", HTTPS_RE, false) ?? ASPHODEL_MCP_URL,
      secret: str(o, "secret", "knowledge", SECRET_RE)!,
      authScheme: "bearer",
      authHeader: "authorization",
      tool: mode,
      queryArg: mode === "recall" ? "query" : "question",
      kArg: "k",
      personaArg: null,
      fixedArgs: mode === "recall" && mindset ? { mindset } : {},
      personaArgs: mode === "recall" ? personaArgs : {},
      sourceLabel: "asphodel",
      timeoutMs: int(o, "timeout_ms", "knowledge", 500, LIMITS.providerTimeoutMs, 3_000),
    };
  }
  fail("knowledge", `unknown knowledge kind ${String(kind)}`);
}

function receiptsEntry(raw: unknown): ReceiptsEntry {
  if (raw === undefined) return { kind: "log" };
  const o = obj(raw, "receipts");
  if (o.kind === "log") {
    only(o, ["kind"], "receipts");
    return { kind: "log" };
  }
  if (o.kind === "http") {
    only(o, ["kind", "url", "secret", "timeout_ms"], "receipts");
    return { kind: "http", url: str(o, "url", "receipts", HTTPS_RE)!, secret: str(o, "secret", "receipts", SECRET_RE, false), timeoutMs: int(o, "timeout_ms", "receipts", 500, LIMITS.providerTimeoutMs, 2_000) };
  }
  fail("receipts", `unknown receipts kind ${String(o.kind)}`);
}
