// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

import { costMicros, type Price, type SttRequest } from "../types";

export interface SttEntryBase {
  id: string;
  kind: string;
  model: string;
  timeoutMs: number;
  price: Price;
}

/** Worst case: the longest clip the relay accepts, whatever this one turns out to be. */
export function sttEstimate(price: Price, req: SttRequest): number {
  return costMicros(price, { minutes: req.maxSeconds / 60 });
}

export function fileName(contentType: string): string {
  const ext: Record<string, string> = { "audio/wav": "wav", "audio/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/flac": "flac" };
  return `clip.${ext[contentType] ?? "bin"}`;
}

/** Multipart form with the audio as `file`, used by OpenAI-style and whisper servers. */
export function audioForm(req: SttRequest, field: string, extra: Record<string, string>): FormData {
  const form = new FormData();
  form.append(field, new Blob([req.audio], { type: req.contentType }), fileName(req.contentType));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}
