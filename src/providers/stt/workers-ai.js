// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Workers AI Whisper (default @cf/openai/whisper-large-v3-turbo), audio passed as base64.

import { ProviderError } from "../types.js";
import { timedAi, toBase64 } from "../http.js";
import { sttEstimate } from "./common.js";
export function workersAiStt(e) {
    return {
        id: e.id,
        kind: "workers-ai",
        model: e.model,
        timeoutMs: e.timeoutMs,
        estimateMicros: (req) => sttEstimate(e.price, req),
        async transcribe(req, ctx) {
            const out = await timedAi(ctx, e.model, { audio: toBase64(req.audio), task: "transcribe", ...(e.language ? { language: e.language } : {}) });
            const text = out?.text;
            if (typeof text !== "string")
                throw new ProviderError("bad_response", "shape");
            return text;
        },
    };
}
