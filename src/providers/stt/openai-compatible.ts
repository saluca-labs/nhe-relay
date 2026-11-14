// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// OpenAI-style transcription: POST {base_url}/audio/transcriptions, multipart, returns {text}.
// Also fits self-hosted servers that copy the API (faster-whisper-server, speaches, LocalAI).

import { ProviderError, type SttProvider } from "../types";
import { timedFetch, jsonBody, optionalSecret } from "../http";
import { sttEstimate, audioForm, type SttEntryBase } from "./common";

export function openAiCompatibleStt(e: SttEntryBase & { baseUrl: string; secret?: string; language?: string }): SttProvider {
  const url = e.baseUrl.replace(/\/+$/, "") + "/audio/transcriptions";
  return {
    id: e.id,
    kind: "openai-compatible",
    model: e.model,
    timeoutMs: e.timeoutMs,
    estimateMicros: (req) => sttEstimate(e.price, req),
    async transcribe(req, ctx) {
      const key = optionalSecret(ctx, e.secret);
      const extra: Record<string, string> = { model: e.model, response_format: "json" };
      if (e.language) extra.language = e.language;
      const r = await timedFetch(ctx, url, {
        method: "POST",
        headers: key ? { authorization: `Bearer ${key}` } : {},
        body: audioForm(req, "file", extra),
      });
      const t = ((await jsonBody(r)) as { text?: unknown })?.text;
      if (typeof t !== "string") throw new ProviderError("bad_response", "shape");
      return t;
    },
  };
}
