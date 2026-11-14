// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

import { costMicros } from "../types.js";

/** @typedef {{ id: string, kind: string, model: string, timeoutMs: number, price: import("../types.js").Price }} SttEntryBase */
/** Worst case: the longest clip the relay accepts, whatever this one turns out to be. */
export function sttEstimate(price, req) {
    return costMicros(price, { minutes: req.maxSeconds / 60 });
}
export function fileName(contentType) {
    const ext = { "audio/wav": "wav", "audio/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/flac": "flac" };
    return `clip.${ext[contentType] ?? "bin"}`;
}
/** Multipart form with the audio as `file`, used by OpenAI-style and whisper servers. */
export function audioForm(req, field, extra) {
    const form = new FormData();
    form.append(field, new Blob([req.audio], { type: req.contentType }), fileName(req.contentType));
    for (const [k, v] of Object.entries(extra))
        form.append(k, v);
    return form;
}
