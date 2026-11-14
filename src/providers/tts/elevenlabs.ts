// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// ElevenLabs text-to-speech. MP3 comes back as MP3; WAV is requested as raw 22.05 kHz PCM and
// wrapped in a WAV header here, because the API's PCM output has no header.

import { ProviderError, type TtsProvider } from "../types";
import { timedFetch, bytesBody, secret } from "../http";
import { ttsEstimate, CONTENT_TYPE, wavFromPcm16, type TtsEntryBase } from "./common";

export const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech";

export function elevenLabsTts(e: TtsEntryBase & { secret: string }): TtsProvider {
  return {
    id: e.id,
    kind: "elevenlabs",
    model: e.model,
    timeoutMs: e.timeoutMs,
    estimateMicros: (req) => ttsEstimate(e.price, req),
    async synthesize(req, ctx) {
      const voice = req.voice ?? e.defaultVoice;
      if (!voice) throw new ProviderError("config", "no_voice");
      const key = secret(ctx, e.secret);
      const outputFormat = e.format === "wav" ? "pcm_22050" : "mp3_44100_128";
      const r = await timedFetch(ctx, `${ELEVENLABS_URL}/${encodeURIComponent(voice)}?output_format=${outputFormat}`, {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": key, accept: e.format === "wav" ? "audio/pcm" : "audio/mpeg" },
        body: JSON.stringify({ text: req.text, model_id: e.model }),
      });
      const body = await bytesBody(r);
      if (body.length === 0) throw new ProviderError("bad_response", "empty");
      return { audio: e.format === "wav" ? wavFromPcm16(body, 22_050) : body, contentType: CONTENT_TYPE[e.format] };
    },
  };
}
