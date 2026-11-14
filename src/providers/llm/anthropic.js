// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Anthropic Messages API over plain HTTP (no SDK: the relay has zero dependencies).
// Default model claude-opus-5-5.
//
// Notes on the model family this targets (Claude Opus 5.5 and later):
// - thinking cannot be disabled; depth is set with output_config.effort. A game turn wants a
//   short answer quickly, so the default effort is "low". Thinking tokens count against
//   max_tokens, so the default max_tokens (2048) is far above the reply cap on purpose.
// - a policy decline arrives as HTTP 200 with stop_reason "refusal". The adapter opts into the
//   server-side fallback ("default") so the API can retry on another model inside the same call,
//   and maps a final refusal to ProviderError("refused"), never to a reply.
// - no retries here: the relay's chain and its time budget decide what happens next.

import { ProviderError } from "../types.js";
import { timedFetch, jsonBody, secret } from "../http.js";
import { llmEstimate } from "./common.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2026-10-21";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * @param {import("./common.js").LlmEntryBase & { secret: string, effort: "low"|"medium"|"high"|"xhigh"|"max", maxTokens: number, fallbacks: boolean }} e
 * @returns {import("../types.js").LlmProvider}
 */
export function anthropicLlm(e) {
    return {
        id: e.id,
        kind: "anthropic",
        model: e.model,
        timeoutMs: e.timeoutMs,
        estimateMicros: (req) => llmEstimate(e.price, { ...req, maxOutputTokens: Math.max(req.maxOutputTokens, e.maxTokens) }),
        async complete(req, ctx) {
            const key = secret(ctx, e.secret);
            /** @type {Record<string, string>} */
            const headers = { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
            if (e.fallbacks)
                headers["anthropic-beta"] = FALLBACK_BETA;
            const r = await timedFetch(ctx, ANTHROPIC_URL, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    model: e.model,
                    max_tokens: Math.max(req.maxOutputTokens, e.maxTokens),
                    system: req.system,
                    messages: [{ role: "user", content: req.user }],
                    output_config: { effort: e.effort },
                    ...(e.fallbacks ? { fallbacks: "default" } : {}),
                }),
            });
            const msg = /** @type {{ stop_reason?: string, stop_details?: { category?: string }, content?: unknown }} */ (await jsonBody(r));
            if (msg?.stop_reason === "refusal")
                throw new ProviderError("refused", msg.stop_details?.category ?? "");
            if (!Array.isArray(msg?.content))
                throw new ProviderError("bad_response", "shape");
            const text = msg.content
                .filter((b) => b && b.type === "text" && typeof b.text === "string")
                .map((b) => b.text)
                .join("");
            if (!text)
                throw new ProviderError("bad_response", msg.stop_reason ?? "empty");
            return text;
        },
    };
}
