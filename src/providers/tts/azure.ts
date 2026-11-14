// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Azure AI Speech text-to-speech (REST). The text goes inside SSML, so it is XML-escaped here;
// the voice name is checked against a strict pattern before it is placed in an attribute.

import { ProviderError, type TtsProvider } from "../types";
import { timedFetch, bytesBody, secret } from "../http";
import { ttsEstimate, CONTENT_TYPE, type TtsEntryBase } from "./common";

const VOICE_RE = /^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9]{1,48}(?::[A-Za-z0-9]{1,32})?$/;

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function azureTts(e: TtsEntryBase & { secret: string; region: string }): TtsProvider {
  const url = `https://${e.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  return {
    id: e.id,
    kind: "azure",
    model: e.model,
    timeoutMs: e.timeoutMs,
    estimateMicros: (req) => ttsEstimate(e.price, req),
    async synthesize(req, ctx) {
      const voice = req.voice ?? e.defaultVoice;
      if (!voice || !VOICE_RE.test(voice)) throw new ProviderError("config", "voice");
      const key = secret(ctx, e.secret);
      const lang = voice.split("-").slice(0, 2).join("-");
      const ssml = `<speak version="1.0" xml:lang="${lang}"><voice name="${voice}">${xmlEscape(req.text)}</voice></speak>`;
      const r = await timedFetch(ctx, url, {
        method: "POST",
        headers: {
          "content-type": "application/ssml+xml",
          "ocp-apim-subscription-key": key,
          "x-microsoft-outputformat": e.format === "wav" ? "riff-24khz-16bit-mono-pcm" : "audio-24khz-48kbitrate-mono-mp3",
          "user-agent": "nhe-relay",
        },
        body: ssml,
      });
      const audio = await bytesBody(r);
      if (audio.length === 0) throw new ProviderError("bad_response", "empty");
      return { audio, contentType: CONTENT_TYPE[e.format] };
    },
  };
}
