// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

import { costMicros, type Price, type TtsRequest } from "../types";

export type AudioFormat = "mp3" | "wav";

export interface TtsEntryBase {
  id: string;
  kind: string;
  model: string;
  timeoutMs: number;
  price: Price;
  format: AudioFormat;
  defaultVoice: string | null;
}

export function ttsEstimate(price: Price, req: TtsRequest): number {
  return costMicros(price, { chars: req.text.length });
}

export const CONTENT_TYPE: Record<AudioFormat, string> = { mp3: "audio/mpeg", wav: "audio/wav" };

/** Wrap raw little-endian 16-bit mono PCM in a WAV (RIFF) header. */
export function wavFromPcm16(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
