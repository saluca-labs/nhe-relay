// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Workers AI text-to-speech (default @cf/deepgram/aura-2-en). WAV is asked for as linear16 in a
// wav container; MP3 as mp3. The binding may hand back a stream, bytes or base64: all are read.

import { ProviderError } from "../types.js";
import { timedAi, audioFromAi } from "../http.js";
import { ttsEstimate, CONTENT_TYPE } from "./common.js";
export function workersAiTts(e) {
    return {
        id: e.id,
        kind: "workers-ai",
        model: e.model,
        timeoutMs: e.timeoutMs,
        estimateMicros: (req) => ttsEstimate(e.price, req),
        async synthesize(req, ctx) {
            const voice = req.voice ?? e.defaultVoice;
            const fmt = e.format === "wav" ? { encoding: "linear16", container: "wav" } : { encoding: "mp3" };
            const out = await timedAi(ctx, e.model, { text: req.text, ...(voice ? { speaker: voice } : {}), ...fmt });
            const audio = await audioFromAi(out);
            if (audio.length === 0)
                throw new ProviderError("bad_response", "empty");
            return { audio, contentType: CONTENT_TYPE[e.format] };
        },
    };
}
