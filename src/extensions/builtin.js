// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// The defaults for the three extension points. None of them calls anything outside the Worker.

/** The built-in guards run in code before any policy is asked, so the default policy allows. */
export function builtinPolicy() {
    return {
        kind: "builtin",
        decide: async () => ({ allow: true }),
        onReceipt: async () => { },
    };
}
export function noKnowledge() {
    return { kind: "none", retrieve: async () => [] };
}
const STOP = new Set(["the", "and", "that", "this", "with", "from", "they", "their", "there", "have", "has", "was", "were", "are", "for", "not", "but", "you", "your", "what", "who", "how", "why", "when", "where", "about", "tell"]);
function words(s) {
    return s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036F]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(" ")
        .filter((w) => w.length >= 3 && !STOP.has(w));
}
/**
 * A lore file bundled with the Worker: {"personas": {"<persona id>": [{id, source, text}, ...]}}.
 * Ranking is plain word overlap with the query; ties keep file order. Good enough for a few
 * hundred passages per persona; use an MCP retriever for anything bigger.
 */
export function localLore(lore) {
    return {
        kind: "local",
        async retrieve(req) {
            const passages = lore[req.persona_id] ?? [];
            const q = new Set(words(req.query));
            if (q.size === 0)
                return [];
            return passages
                .map((p, i) => ({ p, i, score: words(p.text + " " + p.source).filter((w) => q.has(w)).length }))
                .filter((x) => x.score > 0)
                .sort((a, b) => b.score - a.score || a.i - b.i)
                .slice(0, req.k)
                .map((x) => x.p);
        },
    };
}
/** Default sink: the response already carries the receipt; the log gets the root, never content. */
export function logSink(log) {
    return {
        kind: "log",
        emit: async (r) => log({ evt: "receipt", persona_id: r.persona_id, turn_index: r.turn_index, state_root: r.state_root, provider: r.provider }),
    };
}
