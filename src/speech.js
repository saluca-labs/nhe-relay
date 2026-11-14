// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// POST /v1/stt and POST /v1/tts. Same kill switch, limits, global ceiling and spend ceiling as
// /v1/turn.
//
// STT turns a short clip into text and nothing else: the text is not a turn. The client sends it
// to /v1/turn like typed text, where the injection screen and every other check apply.
//
// TTS speaks only text the relay itself produced and checked. /v1/turn returns a ticket, an HMAC
// over (persona, session, state root, sha256 of the reply, expiry); /v1/tts refuses any text
// without a valid, unexpired ticket, and each ticket voices once.

import { LIMITS } from "./limits.js";
import { sanitize } from "./safety.js";
import { checkTtsTicket, textDigest, isRootHex } from "./chain.js";
import { registry, isPersonaId } from "./personas.js";
import { admit, switchedOff, chainDeps, attemptsLog, SESSION_RE } from "./relay.js";
import { runChain, asStt, asTts } from "./providers/run.js";
export const AUDIO_TYPES = new Set(["audio/wav", "audio/webm", "audio/ogg", "audio/mpeg", "audio/flac"]);
/** Seconds of audio in a PCM WAV, from its header; null when the header cannot be read. */
export function wavSeconds(bytes) {
    if (bytes.length < 44)
        return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE")
        return null;
    let o = 12;
    let byteRate = 0;
    while (o + 8 <= bytes.length) {
        const id = tag(o);
        const size = v.getUint32(o + 4, true);
        if (id === "fmt " && o + 20 <= bytes.length)
            byteRate = v.getUint32(o + 16, true);
        if (id === "data")
            return byteRate > 0 ? Math.min(size, bytes.length - o - 8) / byteRate : null;
        o += 8 + size + (size % 2);
    }
    return null;
}
function meta(ms) {
    return { provider: null, model: null, ms };
}
export async function handleStt(audio, contentType, sessionId, ip, env, deps) {
    const now = deps.now ?? Date.now;
    const t0 = now();
    const done = (status, r, extra = {}) => {
        deps.log({ evt: "stt", status, fallback: r.fallback, reason: r.reason ?? null, provider: r.meta.provider, ms: now() - t0, bytes: audio.length, ...extra });
        return { status, body: r };
    };
    const refuse = (reason, status = 200) => done(status, { text: "", truncated: false, fallback: true, reason, meta: meta(now() - t0) });
    const off = switchedOff(env, deps);
    if (off)
        return refuse(off);
    const cfg = deps.config;
    if (cfg.stt.length === 0)
        return refuse("no_stt_provider", 404);
    if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId))
        return refuse("session_id", 400);
    const type = contentType.split(";")[0].trim().toLowerCase();
    if (!AUDIO_TYPES.has(type))
        return refuse("audio_type", 415);
    if (audio.length === 0)
        return refuse("audio_empty", 400);
    if (audio.length > LIMITS.maxAudioBytes)
        return refuse("audio_size", 413);
    if (type === "audio/wav") {
        const secs = wavSeconds(audio);
        if (secs === null)
            return refuse("audio_header", 400);
        if (secs > LIMITS.maxSttSeconds)
            return refuse("audio_too_long", 413);
    }
    const limited = await admit(env, deps, ip, sessionId);
    if (limited)
        return refuse(limited.reason, limited.status);
    const cd = chainDeps(env, cfg, deps, cfg.turnBudgetMs, "stt", null);
    if (!cd)
        return refuse("config_unreadable");
    const result = await runChain(cfg.stt.map(asStt), { audio, contentType: type, maxSeconds: LIMITS.maxSttSeconds }, cd);
    if (!result.ok || result.value === undefined) {
        const allSpend = result.attempts.length > 0 && result.attempts.every((a) => a.outcome === "spend_ceiling");
        return done(allSpend ? 429 : 200, { text: "", truncated: false, fallback: true, reason: allSpend ? "spend_ceiling" : "stt_unavailable", meta: meta(now() - t0) }, { attempts: attemptsLog(result.attempts) });
    }
    const clean = sanitize(result.value);
    const truncated = clean.length > LIMITS.maxPlayerText;
    const text = truncated ? clean.slice(0, LIMITS.maxPlayerText) : clean;
    if (text.length === 0)
        return done(200, { text: "", truncated: false, fallback: true, reason: "stt_empty", meta: { provider: result.provider?.id ?? null, model: result.provider?.model ?? null, ms: now() - t0 } });
    return done(200, { text, truncated, fallback: false, meta: { provider: result.provider?.id ?? null, model: result.provider?.model ?? null, ms: now() - t0 } }, { chars: text.length });
}
export async function handleTts(body, ip, env, deps) {
    const now = deps.now ?? Date.now;
    const t0 = now();
    const refuse = (reason, status = 200) => {
        deps.log({ evt: "tts", status, fallback: true, reason, ms: now() - t0 });
        return { kind: "refusal", status, body: { fallback: true, reason, meta: meta(now() - t0) } };
    };
    const off = switchedOff(env, deps);
    if (off)
        return refuse(off);
    const cfg = deps.config;
    const key = env.RELAY_HMAC_KEY;
    if (cfg.tts.length === 0)
        return refuse("no_tts_provider", 404);
    if (typeof body !== "object" || body === null || Array.isArray(body))
        return refuse("body_type", 400);
    const b = body;
    const allowed = new Set(["persona_id", "session_id", "state_root", "text", "exp", "ticket"]);
    for (const k of Object.keys(b))
        if (!allowed.has(k))
            return refuse("unknown_field", 400);
    if (!isPersonaId(b.persona_id))
        return refuse("persona_id", 400);
    const persona = registry().get(b.persona_id);
    if (!persona)
        return refuse("unknown_persona", 404);
    if (typeof b.session_id !== "string" || !SESSION_RE.test(b.session_id))
        return refuse("session_id", 400);
    if (!isRootHex(b.state_root))
        return refuse("state_root_format", 400);
    if (typeof b.text !== "string" || b.text.length === 0 || b.text.length > LIMITS.maxNpcText)
        return refuse("text", 400);
    if (typeof b.exp !== "number" || !Number.isSafeInteger(b.exp))
        return refuse("exp", 400);
    const nowSec = Math.floor(now() / 1000);
    if (b.exp < nowSec || b.exp > nowSec + LIMITS.ttsTicketTtlSec)
        return refuse("ticket_expired", 400);
    // The ticket binds the exact text to a reply this relay checked: no ticket, no voice.
    const fields = { persona_id: persona.id, session_id: b.session_id, state_root: b.state_root, text_sha256: await textDigest(b.text), exp: b.exp };
    if (!(await checkTtsTicket(key, fields, b.ticket)))
        return refuse("ticket", 400);
    // Limits, plus once per ticket (the ticket lives at most ttsTicketTtlSec).
    const once = { key: `tts_once:${b.ticket.slice(0, 32)}`, limit: 1, windowSec: 86_400 };
    const limited = await admit(env, deps, ip, b.session_id, [once]);
    if (limited)
        return refuse(limited.reason === "rate_tts_once" ? "ticket_used" : limited.reason, limited.status);
    const cd = chainDeps(env, cfg, deps, cfg.turnBudgetMs, "tts", persona.id);
    if (!cd)
        return refuse("config_unreadable");
    const text = b.text;
    // Each provider gets the persona's voice for that provider id, or its own default.
    const chain = cfg.tts.map((p) => ({ ...asTts(p), run: asTts({ ...p, synthesize: (req, c) => p.synthesize({ ...req, voice: persona.tts_voice?.[p.id] ?? null }, c) }).run }));
    const result = await runChain(chain, { text, voice: null }, cd);
    if (!result.ok || result.value === undefined) {
        deps.log({ evt: "tts_attempts", attempts: attemptsLog(result.attempts) });
        const allSpend = result.attempts.length > 0 && result.attempts.every((a) => a.outcome === "spend_ceiling");
        return refuse(allSpend ? "spend_ceiling" : "tts_unavailable", allSpend ? 429 : 200);
    }
    const m = { provider: result.provider?.id ?? null, model: result.provider?.model ?? null, ms: now() - t0 };
    deps.log({ evt: "tts", status: 200, fallback: false, provider: m.provider, ms: m.ms, chars: text.length, bytes: result.value.audio.length });
    return { kind: "audio", audio: result.value, meta: m };
}
