// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

import { takeAll } from "../src/limiter-core.js";
import { genesis } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
export const HMAC = "test-only-hmac-key-0123456789abcdef0123456789";
export const NOW = 1_700_000_000_000;
export function env(over = {}) {
    return { RELAY_ENABLED: "yes", RELAY_HMAC_KEY: HMAC, LLM_KEY: "test-key-not-real", ...over };
}
/** Two flat-priced OpenAI-compatible LLMs (primary, then secondary), no speech. */
export function rawConfig(over = {}) {
    return {
        llm: [
            { id: "primary", kind: "openai-compatible", base_url: "https://llm-a.test/v1", model: "model-a", secret: "LLM_KEY", timeout_ms: 4000, price: { flat: true } },
            { id: "secondary", kind: "openai-compatible", base_url: "https://llm-b.test/v1", model: "model-b", secret: "LLM_KEY", timeout_ms: 4000, price: { flat: true } },
        ],
        turn_budget_ms: 7000,
        spend: { daily_usd_ceiling: 1 },
        cors: { origins: ["https://game.example"], allow_localhost: true },
        ...over,
    };
}
export function config(over = {}) {
    return loadConfig(rawConfig(over));
}
export function mapStore(m = new Map()) {
    return {
        m,
        get: async (k) => m.get(k),
        put: async (e) => {
            for (const [k, v] of Object.entries(e))
                m.set(k, v);
        },
    };
}
export function modelReply(obj, status = 200) {
    const calls = [];
    const fetcher = async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init.body)), headers: (init.headers ?? {}) });
        if (status !== 200)
            return new Response("no", { status });
        const content = typeof obj === "string" ? obj : JSON.stringify(obj);
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    };
    return { fetcher, calls };
}
export function deps(over = {}, store = mapStore()) {
    const logs = [];
    const { fetcher } = modelReply({ say: "Welcome back! The usual?", remember: ["likes tea"], summary: "A regular who likes tea." });
    return {
        take: (rules) => takeAll(store, rules, NOW),
        fetcher,
        log: (r) => logs.push(r),
        config: config(),
        now: () => NOW,
        ...over,
        logs,
        store,
    };
}
export const SESSION = "session-abc123";
export async function firstTurn(text = "Hello, I am Sam.", persona = "test-npc-fixture") {
    return {
        persona_id: persona,
        session_id: SESSION,
        player_text: text,
        memory: { summary: "", facts: [], turn_count: 0 },
        state_root: await genesis(persona, SESSION),
    };
}
/** A PCM WAV of the given length in seconds (silence), 16 kHz mono 16-bit. */
export function wav(seconds) {
    const rate = 16_000;
    const n = Math.round(seconds * rate) * 2;
    const out = new Uint8Array(44 + n);
    const v = new DataView(out.buffer);
    const ascii = (o, s) => {
        for (let i = 0; i < s.length; i++)
            out[o + i] = s.charCodeAt(i);
    };
    ascii(0, "RIFF");
    v.setUint32(4, 36 + n, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    ascii(36, "data");
    v.setUint32(40, n, true);
    return out;
}
