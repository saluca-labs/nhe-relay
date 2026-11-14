// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// A self-hosted TTS server behind a fixed https URL. Two request shapes:
//   "piper"         POST {text, voice?}  ->  WAV bytes (the Piper HTTP server)
//   "openai-speech" POST {model, input, voice, response_format}  ->  audio bytes
//                   (the OpenAI speech API shape, used by Chatterbox API servers and others)

import { ProviderError } from "../types.js";
import { timedFetch, bytesBody, optionalSecret } from "../http.js";
import { ttsEstimate, CONTENT_TYPE } from "./common.js";
export function httpTts(e) {
    return {
        id: e.id,
        kind: "http",
        model: e.model,
        timeoutMs: e.timeoutMs,
        estimateMicros: (req) => ttsEstimate(e.price, req),
        async synthesize(req, ctx) {
            const key = optionalSecret(ctx, e.secret);
            const voice = req.voice ?? e.defaultVoice;
            const body = e.shape === "piper"
                ? { text: req.text, ...(voice ? { voice } : {}) }
                : { model: e.model, input: req.text, voice: voice ?? "default", response_format: e.format };
            const headers = { "content-type": "application/json" };
            if (key)
                headers.authorization = `Bearer ${key}`;
            const r = await timedFetch(ctx, e.url, { method: "POST", headers, body: JSON.stringify(body) });
            const audio = await bytesBody(r);
            if (audio.length === 0)
                throw new ProviderError("bad_response", "empty");
            return { audio, contentType: CONTENT_TYPE[e.format] };
        },
    };
}
