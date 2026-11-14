// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// A minimal JavaScript client for nhe-relay, for a browser game or Node 20+ (global fetch). No
// build step: import it as an ES module. It keeps the client-held state (memory, state root,
// receipt) between turns, verifies each new root before storing it, and shows the persona
// fallback line whenever the relay says so.
//
//   import { RelayClient } from "./client.js";
//   const npc = new RelayClient("https://nhe-relay.example.workers.dev", "museum-guide", "player-0001");
//   const reply = await npc.say("What happened in the flood?");
//   const audio = await npc.speak(reply);   // a Blob, or null when speech is off or refused

/** @typedef {{ summary: string, facts: string[], turn_count: number }} Memory */
/**
 * @typedef {object} TurnReply
 * @property {string} npc_text
 * @property {Memory} memory
 * @property {string} state_root
 * @property {string} [receipt]
 * @property {{ ticket: string, exp: number }} [tts]
 * @property {{ id: string, source: string, notice?: string }[]} [citations]
 * @property {boolean} fallback
 * @property {string} [reason]
 * @property {{ prev: string, turn: Record<string, unknown> }} [chain]
 */

export class RelayClient {
    /**
     * @param {string} base relay base URL
     * @param {string} personaId
     * @param {string} sessionId 8 to 64 of A-Z a-z 0-9 _ -
     */
    constructor(base, personaId, sessionId) {
        this.base = base;
        this.personaId = personaId;
        this.sessionId = sessionId;
        /** @type {Memory} */
        this.memory = { summary: "", facts: [], turn_count: 0 };
        /** @type {string | null} */
        this.root = null;
        /** @type {string | undefined} */
        this.receipt = undefined;
    }

    /**
     * One turn. On fallback the stored state is left exactly as it was.
     * @param {string} playerText
     * @param {Record<string, unknown>} [scene]
     * @returns {Promise<TurnReply>}
     */
    async say(playerText, scene) {
        if (this.root === null) {
            const g = await fetch(`${this.base}/v1/genesis?persona_id=${encodeURIComponent(this.personaId)}&session_id=${encodeURIComponent(this.sessionId)}`);
            if (!g.ok) throw new Error(`genesis ${g.status}`);
            this.root = (await g.json()).state_root;
        }
        const res = await fetch(`${this.base}/v1/turn`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                persona_id: this.personaId,
                session_id: this.sessionId,
                player_text: playerText,
                memory: this.memory,
                state_root: this.root,
                ...(this.receipt ? { receipt: this.receipt } : {}),
                ...(scene ? { scene } : {}),
            }),
        });
        /** @type {TurnReply} */
        const reply = await res.json();
        if (!reply.fallback && reply.chain && (await verifyRoot(reply.chain.prev, reply.chain.turn, reply.state_root))) {
            this.memory = reply.memory;
            this.root = reply.state_root;
            this.receipt = reply.receipt;
        }
        return reply;
    }

    /**
     * Speech for a reply this client received. Returns null on any refusal.
     * @param {TurnReply} reply
     * @returns {Promise<Blob | null>}
     */
    async speak(reply) {
        if (reply.fallback || !reply.tts) return null;
        const res = await fetch(`${this.base}/v1/tts`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ persona_id: this.personaId, session_id: this.sessionId, state_root: reply.state_root, text: reply.npc_text, exp: reply.tts.exp, ticket: reply.tts.ticket }),
        });
        const type = res.headers.get("content-type") ?? "";
        return res.ok && type.startsWith("audio/") ? res.blob() : null;
    }

    /**
     * Speech to text for a short clip (WAV, WebM, Ogg, MP3 or FLAC).
     * @param {Blob} clip
     * @returns {Promise<string | null>}
     */
    async listen(clip) {
        const res = await fetch(`${this.base}/v1/stt?session_id=${encodeURIComponent(this.sessionId)}`, { method: "POST", headers: { "content-type": clip.type }, body: clip });
        const j = await res.json();
        return j.fallback ? null : j.text;
    }
}

// ---- chain verification: the same rules the relay uses (RFC 8785 over its value domain) ----

/** @param {unknown} v @returns {string} */
function canonical(v) {
    if (v === null) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") {
        if (!Number.isSafeInteger(v)) throw new Error("only safe integers");
        return String(v);
    }
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (typeof v === "object") {
        const o = /** @type {Record<string, unknown>} */ (v);
        return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
    }
    throw new Error("unsupported");
}

/**
 * @param {string} prev
 * @param {Record<string, unknown>} turn
 * @param {string} expected
 */
async function verifyRoot(prev, turn, expected) {
    const prevBytes = new Uint8Array((prev.match(/../g) ?? []).map((h) => parseInt(h, 16)));
    const body = new TextEncoder().encode(canonical(turn));
    const buf = new Uint8Array(prevBytes.length + body.length);
    buf.set(prevBytes);
    buf.set(body, prevBytes.length);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") === expected;
}
