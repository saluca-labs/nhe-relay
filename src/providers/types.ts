// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// The provider layer. Three interfaces (LLM, STT, TTS), one error type, one cost hook.
// Every adapter:
//   - takes its model, endpoint and secret NAME from relay.config.json (never a key);
//   - runs under a hard timeout given by the caller;
//   - maps every failure to a ProviderError with a short machine kind;
//   - states its worst-case cost before it runs, so the spend ceiling can refuse it first.

export type ProviderErrorKind =
  | "timeout" // the call did not finish inside its timeout
  | "auth" // 401 or 403: a missing, wrong or revoked key
  | "rate_limited" // 429 from the provider
  | "bad_request" // 400, 404, 413, 415 or 422: the provider refused the request shape
  | "upstream" // 5xx, a network error, or a thrown binding error
  | "bad_response" // a 2xx whose body is not the documented shape
  | "refused" // the provider declined on policy (for example Anthropic stop_reason "refusal")
  | "config"; // a required secret or binding is missing: cannot tell is a refusal

export class ProviderError extends Error {
  constructor(public kind: ProviderErrorKind, detail = "") {
    super(detail ? `${kind}:${detail}`.slice(0, 60) : kind);
    this.name = "ProviderError";
  }
}

export function statusKind(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream";
  return "bad_request";
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Workers AI binding, as far as the adapters use it. */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

export interface ProviderEnv {
  AI?: AiBinding;
  [secret: string]: unknown;
}

export interface CallContext {
  env: ProviderEnv;
  fetcher: FetchLike;
  timeoutMs: number;
}

/** Prices are declared in the config. "flat" means no marginal cost (free tier or flat fee). */
export type Price =
  | { flat: true }
  | { input_usd_per_mtok: number; output_usd_per_mtok: number }
  | { usd_per_minute: number }
  | { usd_per_mchar: number };

export interface ProviderBase {
  id: string;
  kind: string;
  timeoutMs: number;
}

// ---- LLM ----------------------------------------------------------------------------------

export interface LlmRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
}

export interface LlmProvider extends ProviderBase {
  model: string;
  /** Worst-case cost of this request in micro-dollars (an integer, 0 for flat). */
  estimateMicros(req: LlmRequest): number;
  complete(req: LlmRequest, ctx: CallContext): Promise<string>;
}

// ---- STT ----------------------------------------------------------------------------------

export interface SttRequest {
  audio: Uint8Array;
  contentType: string;
  maxSeconds: number;
}

export interface SttProvider extends ProviderBase {
  model: string;
  estimateMicros(req: SttRequest): number;
  transcribe(req: SttRequest, ctx: CallContext): Promise<string>;
}

// ---- TTS ----------------------------------------------------------------------------------

export interface TtsRequest {
  text: string;
  voice: string | null; // the persona's voice for this provider, or null for the provider default
}

export interface TtsAudio {
  audio: Uint8Array;
  contentType: string;
}

export interface TtsProvider extends ProviderBase {
  model: string;
  estimateMicros(req: TtsRequest): number;
  synthesize(req: TtsRequest, ctx: CallContext): Promise<TtsAudio>;
}

// ---- cost ---------------------------------------------------------------------------------

/** Rough, deliberately high token estimate: three characters per token. */
export function tokensFor(chars: number): number {
  return Math.ceil(chars / 3);
}

/**
 * Micro-dollars for one call. A per-million price in dollars is exactly a per-unit price in
 * micro-dollars, which keeps the arithmetic in integers after one ceil.
 */
export function costMicros(price: Price, units: { inTokens?: number; outTokens?: number; minutes?: number; chars?: number }): number {
  if ("flat" in price) return 0;
  if ("input_usd_per_mtok" in price) return Math.ceil((units.inTokens ?? 0) * price.input_usd_per_mtok + (units.outTokens ?? 0) * price.output_usd_per_mtok);
  if ("usd_per_minute" in price) return Math.ceil((units.minutes ?? 0) * price.usd_per_minute * 1_000_000);
  return Math.ceil((units.chars ?? 0) * price.usd_per_mchar);
}
