// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// The provider layer. Three interfaces (LLM, STT, TTS), one error type, one cost hook.
// Every adapter:
//   - takes its model, endpoint and secret NAME from relay.config.js (never a key);
//   - runs under a hard timeout given by the caller;
//   - maps every failure to a ProviderError with a short machine kind;
//   - states its worst-case cost before it runs, so the spend ceiling can refuse it first.
// Types are JSDoc comments: nothing here needs compiling.

/**
 * @typedef {"timeout" | "auth" | "rate_limited" | "bad_request" | "upstream" | "bad_response" | "refused" | "config"} ProviderErrorKind
 *   timeout: did not finish inside its timeout. auth: 401 or 403. rate_limited: 429.
 *   bad_request: 400, 404, 413, 415 or 422. upstream: 5xx, a network error or a thrown binding error.
 *   bad_response: a 2xx whose body is not the documented shape. refused: a policy decline.
 *   config: a required secret or binding is missing (cannot tell is a refusal).
 */

/** @typedef {(input: string, init: RequestInit) => Promise<Response>} FetchLike */

/** @typedef {{ run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> }} AiBinding */

/** @typedef {{ AI?: AiBinding, [secret: string]: unknown }} ProviderEnv */

/** @typedef {{ env: ProviderEnv, fetcher: FetchLike, timeoutMs: number }} CallContext */

/**
 * Prices are declared in the config. `flat` means no marginal cost (free tier or flat fee).
 * @typedef {{ flat: true } | { input_usd_per_mtok: number, output_usd_per_mtok: number } | { usd_per_minute: number } | { usd_per_mchar: number }} Price
 */

/** @typedef {{ system: string, user: string, maxOutputTokens: number }} LlmRequest */
/**
 * @typedef {object} LlmProvider
 * @property {string} id
 * @property {string} kind
 * @property {string} model
 * @property {number} timeoutMs
 * @property {(req: LlmRequest) => number} estimateMicros worst-case cost in micro-dollars (0 for flat)
 * @property {(req: LlmRequest, ctx: CallContext) => Promise<string>} complete
 */

/** @typedef {{ audio: Uint8Array, contentType: string, maxSeconds: number }} SttRequest */
/**
 * @typedef {object} SttProvider
 * @property {string} id
 * @property {string} kind
 * @property {string} model
 * @property {number} timeoutMs
 * @property {(req: SttRequest) => number} estimateMicros
 * @property {(req: SttRequest, ctx: CallContext) => Promise<string>} transcribe
 */

/** @typedef {{ text: string, voice: string | null }} TtsRequest */
/** @typedef {{ audio: Uint8Array, contentType: string }} TtsAudio */
/**
 * @typedef {object} TtsProvider
 * @property {string} id
 * @property {string} kind
 * @property {string} model
 * @property {number} timeoutMs
 * @property {(req: TtsRequest) => number} estimateMicros
 * @property {(req: TtsRequest, ctx: CallContext) => Promise<TtsAudio>} synthesize
 */

export class ProviderError extends Error {
    /**
     * @param {ProviderErrorKind} kind
     * @param {string} [detail]
     */
    constructor(kind, detail = "") {
        super(detail ? `${kind}:${detail}`.slice(0, 60) : kind);
        this.kind = kind;
        this.name = "ProviderError";
    }
}

/** @param {number} status @returns {ProviderErrorKind} */
export function statusKind(status) {
    if (status === 401 || status === 403)
        return "auth";
    if (status === 429)
        return "rate_limited";
    if (status >= 500)
        return "upstream";
    return "bad_request";
}

// ---- cost ---------------------------------------------------------------------------------

/** Rough, deliberately high token estimate: three characters per token. @param {number} chars */
export function tokensFor(chars) {
    return Math.ceil(chars / 3);
}

/**
 * Micro-dollars for one call. A per-million price in dollars is exactly a per-unit price in
 * micro-dollars, which keeps the arithmetic in integers after one ceil.
 * @param {Price} price
 * @param {{ inTokens?: number, outTokens?: number, minutes?: number, chars?: number }} units
 */
export function costMicros(price, units) {
    if ("flat" in price)
        return 0;
    if ("input_usd_per_mtok" in price)
        return Math.ceil((units.inTokens ?? 0) * price.input_usd_per_mtok + (units.outTokens ?? 0) * price.output_usd_per_mtok);
    if ("usd_per_minute" in price)
        return Math.ceil((units.minutes ?? 0) * price.usd_per_minute * 1_000_000);
    return Math.ceil((units.chars ?? 0) * price.usd_per_mchar);
}
