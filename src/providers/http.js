// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Shared plumbing for adapters: a fetch with a hard timeout and error mapping, a Workers AI
// binding call with the same, and secret lookup by NAME.

import { ProviderError, statusKind } from "./types.js";
/** POST (or any method) with an abort timer. Non-2xx becomes a ProviderError; the body is not read. */
export async function timedFetch(ctx, url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("timeout"), ctx.timeoutMs);
    let r;
    try {
        r = await ctx.fetcher(url, { ...init, signal: ctrl.signal });
    }
    catch (e) {
        if (ctrl.signal.aborted)
            throw new ProviderError("timeout");
        throw new ProviderError("upstream", e instanceof Error ? e.name : "fetch");
    }
    finally {
        clearTimeout(timer);
    }
    if (!r.ok)
        throw new ProviderError(statusKind(r.status), `http_${r.status}`);
    return r;
}
/** Read a JSON body or fail as bad_response. */
export async function jsonBody(r) {
    try {
        return await r.json();
    }
    catch {
        throw new ProviderError("bad_response", "json");
    }
}
export async function bytesBody(r) {
    try {
        return new Uint8Array(await r.arrayBuffer());
    }
    catch {
        throw new ProviderError("bad_response", "body");
    }
}
/** Run a Workers AI model under the same timeout. Any thrown error is upstream. */
export async function timedAi(ctx, model, input, options) {
    const ai = ctx.env.AI;
    if (!ai || typeof ai.run !== "function")
        throw new ProviderError("config", "no_ai_binding");
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError("timeout")), ctx.timeoutMs);
    });
    try {
        return await Promise.race([ai.run(model, input, options), timeout]);
    }
    catch (e) {
        if (e instanceof ProviderError)
            throw e;
        throw new ProviderError("upstream", e instanceof Error ? e.name : "ai");
    }
    finally {
        if (timer !== null)
            clearTimeout(timer);
    }
}
/** A secret by its configured NAME. Missing or empty is a config error (cannot tell). */
export function secret(ctx, name) {
    if (!name)
        throw new ProviderError("config", "secret_name");
    const v = ctx.env[name];
    if (typeof v !== "string" || v.length === 0)
        throw new ProviderError("config", "secret_missing");
    return v;
}
export function optionalSecret(ctx, name) {
    return name ? secret(ctx, name) : null;
}
/** Base64 of bytes, without Node's Buffer (Workers has btoa). */
export function toBase64(bytes) {
    let s = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK)
        s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return btoa(s);
}
export function fromBase64(b64) {
    const s = atob(b64.replace(/^data:[^,]*,/, ""));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++)
        out[i] = s.charCodeAt(i);
    return out;
}
/** Turn whatever a Workers AI audio model returned into bytes. */
export async function audioFromAi(result) {
    if (result instanceof Uint8Array)
        return result;
    if (result instanceof ArrayBuffer)
        return new Uint8Array(result);
    if (result instanceof Response)
        return bytesBody(result);
    if (result instanceof ReadableStream)
        return bytesBody(new Response(result));
    if (typeof result === "object" && result !== null && typeof result.audio === "string") {
        try {
            return fromBase64(result.audio);
        }
        catch {
            throw new ProviderError("bad_response", "audio_b64");
        }
    }
    throw new ProviderError("bad_response", "audio_shape");
}
