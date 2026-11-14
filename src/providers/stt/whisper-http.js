// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// A self-hosted Whisper behind a plain URL, for example whisper.cpp's server (POST /inference,
// multipart field "file", JSON {text}). The URL is fixed in the config and must be https (put
// your server behind a tunnel or a reverse proxy with TLS); an optional bearer secret.

import { ProviderError } from "../types.js";
import { timedFetch, jsonBody, optionalSecret } from "../http.js";
import { sttEstimate, audioForm } from "./common.js";
export function whisperHttpStt(e) {
    return {
        id: e.id,
        kind: "whisper-http",
        model: e.model,
        timeoutMs: e.timeoutMs,
        estimateMicros: (req) => sttEstimate(e.price, req),
        async transcribe(req, ctx) {
            const key = optionalSecret(ctx, e.secret);
            const r = await timedFetch(ctx, e.url, {
                method: "POST",
                headers: key ? { authorization: `Bearer ${key}` } : {},
                body: audioForm(req, e.field, { response_format: "json" }),
            });
            const t = (await jsonBody(r))?.text;
            if (typeof t !== "string")
                throw new ProviderError("bad_response", "shape");
            return t;
        },
    };
}
