// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// OpenRouter chat completions. With free_only (the default), a model id that does not end in
// ":free" is refused before any request is made, so a typo cannot reach a metered model.

import { ProviderError } from "../types.js";
import { timedFetch, jsonBody, secret } from "../http.js";
import { llmEstimate, chatCompletionText } from "./common.js";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export function openRouterLlm(e) {
    return {
        id: e.id,
        kind: "openrouter",
        model: e.model,
        timeoutMs: e.timeoutMs,
        estimateMicros: (req) => llmEstimate(e.price, req),
        async complete(req, ctx) {
            if (e.freeOnly && !e.model.endsWith(":free"))
                throw new ProviderError("config", "not_free");
            const key = secret(ctx, e.secret);
            const r = await timedFetch(ctx, OPENROUTER_URL, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model: e.model,
                    messages: [
                        { role: "system", content: req.system },
                        { role: "user", content: req.user },
                    ],
                    max_tokens: req.maxOutputTokens,
                    temperature: 0.7,
                    response_format: { type: "json_object" },
                }),
            });
            const text = chatCompletionText(await jsonBody(r));
            if (text === null)
                throw new ProviderError("bad_response", "shape");
            return text;
        },
    };
}
