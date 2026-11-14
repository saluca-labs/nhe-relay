// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Memory lives on the CLIENT. Whatever comes back is untrusted: every field is type checked and
// bounded, and anything malformed is a refusal rather than a repair.

import { LIMITS } from "./limits.js";
import { sanitize, screenInjection, containsUrl } from "./safety.js";
export function validateMemory(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return { ok: false, reason: "memory_type" };
    const m = raw;
    const allowed = new Set(["summary", "facts", "turn_count"]);
    for (const k of Object.keys(m))
        if (!allowed.has(k))
            return { ok: false, reason: "memory_unknown_field" };
    if (typeof m.summary !== "string")
        return { ok: false, reason: "memory_summary_type" };
    if (m.summary.length > LIMITS.maxSummary)
        return { ok: false, reason: "memory_summary_size" };
    if (!Array.isArray(m.facts))
        return { ok: false, reason: "memory_facts_type" };
    if (m.facts.length > LIMITS.maxFacts)
        return { ok: false, reason: "memory_facts_count" };
    const facts = [];
    for (const f of m.facts) {
        if (typeof f !== "string")
            return { ok: false, reason: "memory_fact_type" };
        if (f.length > LIMITS.maxFactChars)
            return { ok: false, reason: "memory_fact_size" };
        facts.push(f);
    }
    if (typeof m.turn_count !== "number" || !Number.isSafeInteger(m.turn_count) || m.turn_count < 0 || m.turn_count > LIMITS.maxTurnCount) {
        return { ok: false, reason: "memory_turn_count" };
    }
    // The memory is fed to the model, so it gets the same screens as player text. Text the relay
    // itself wrote passes these, so a hit means the client edited it.
    const summary = sanitize(m.summary);
    if (summary !== m.summary || facts.some((f) => sanitize(f) !== f))
        return { ok: false, reason: "memory_not_clean" };
    const all = [summary, ...facts].join("\n");
    if (screenInjection(all) || containsUrl(all))
        return { ok: false, reason: "memory_screened" };
    return { ok: true, memory: { summary, facts, turn_count: m.turn_count } };
}
/** Merge model-proposed memory into the bounded shape. Unsafe or oversized proposals are dropped. */
export function mergeMemory(prev, proposedSummary, proposedFacts) {
    let summary = prev.summary;
    if (typeof proposedSummary === "string") {
        const s = sanitize(proposedSummary).slice(0, LIMITS.maxSummary);
        if (s && !screenInjection(s) && !containsUrl(s))
            summary = s;
    }
    const facts = [...prev.facts];
    if (Array.isArray(proposedFacts)) {
        for (const f of proposedFacts.slice(0, 4)) {
            if (typeof f !== "string")
                continue;
            const s = sanitize(f);
            if (!s || s.length > LIMITS.maxFactChars || screenInjection(s) || containsUrl(s))
                continue;
            if (facts.some((x) => x.toLowerCase() === s.toLowerCase()))
                continue;
            facts.push(s);
        }
    }
    return { summary, facts: facts.slice(-LIMITS.maxFacts), turn_count: prev.turn_count + 1 };
}
