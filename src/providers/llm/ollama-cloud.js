// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Ollama Cloud chat API (flat-fee subscription). Bearer key from the named secret.

import { ProviderError } from "../types.js";
import { timedFetch, jsonBody, secret } from "../http.js";
import { llmEstimate } from "./common.js";
export const OLLAMA_URL = "https://ollama.com/api/chat";
export function ollamaCloudLlm(e) {
    return {
        id: e.id,
        kind: "ollama-cloud",
        model: e.model,
        timeoutMs: e.timeoutMs,
        estimateMicros: (req) => llmEstimate(e.price, req),
        async complete(req, ctx) {
            const key = secret(ctx, e.secret);
            const r = await timedFetch(ctx, OLLAMA_URL, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model: e.model,
                    messages: [
                        { role: "system", content: req.system },
                        { role: "user", content: req.user },
                    ],
                    stream: false,
                    format: "json",
                    think: false,
                    options: { temperature: 0.7, num_predict: req.maxOutputTokens },
                }),
            });
            const j = (await jsonBody(r));
            if (typeof j?.message?.content !== "string")
                throw new ProviderError("bad_response", "shape");
            return j.message.content;
        },
    };
}
