// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Any server that speaks the OpenAI chat-completions API (vLLM, llama.cpp server, LM Studio,
// a hosted gateway). base_url is fixed in the config and must be https; the key is optional.

import { ProviderError } from "../types.js";
import { timedFetch, jsonBody, optionalSecret } from "../http.js";
import { llmEstimate, chatCompletionText } from "./common.js";
export function openAiCompatibleLlm(e) {
    const url = e.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    return {
        id: e.id,
        kind: "openai-compatible",
        model: e.model,
        timeoutMs: e.timeoutMs,
        estimateMicros: (req) => llmEstimate(e.price, req),
        async complete(req, ctx) {
            const key = optionalSecret(ctx, e.secret);
            const headers = { "content-type": "application/json" };
            if (key)
                headers.authorization = `Bearer ${key}`;
            const r = await timedFetch(ctx, url, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    model: e.model,
                    messages: [
                        { role: "system", content: req.system },
                        { role: "user", content: req.user },
                    ],
                    max_tokens: req.maxOutputTokens,
                    temperature: 0.7,
                    ...(e.jsonMode ? { response_format: { type: "json_object" } } : {}),
                }),
            });
            const text = chatCompletionText(await jsonBody(r));
            if (text === null)
                throw new ProviderError("bad_response", "shape");
            return text;
        },
    };
}
