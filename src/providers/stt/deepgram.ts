// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Deepgram pre-recorded transcription: the raw audio is the body, the key is a Token header.

import { ProviderError, type SttProvider } from "../types";
import { timedFetch, jsonBody, secret } from "../http";
import { sttEstimate, type SttEntryBase } from "./common";

export const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";

export function deepgramStt(e: SttEntryBase & { secret: string; language?: string }): SttProvider {
  return {
    id: e.id,
    kind: "deepgram",
    model: e.model,
    timeoutMs: e.timeoutMs,
    estimateMicros: (req) => sttEstimate(e.price, req),
    async transcribe(req, ctx) {
      const key = secret(ctx, e.secret);
      const q = new URLSearchParams({ model: e.model, smart_format: "true", ...(e.language ? { language: e.language } : {}) });
      const r = await timedFetch(ctx, `${DEEPGRAM_URL}?${q}`, {
        method: "POST",
        headers: { "content-type": req.contentType, authorization: `Token ${key}` },
        body: req.audio,
      });
      const j = (await jsonBody(r)) as { results?: { channels?: { alternatives?: { transcript?: unknown }[] }[] } };
      const t = j?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
      if (typeof t !== "string") throw new ProviderError("bad_response", "shape");
      return t;
    },
  };
}
