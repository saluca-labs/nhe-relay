// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Builds the configured policy, knowledge provider and receipt sink for one request, and holds
// the rules that apply to retrieved text whatever its source.

import { sanitize, screenInjection, containsUrl } from "../safety.js";
import { reveals } from "../scene.js";
import { builtinPolicy, noKnowledge, localLore, logSink } from "./builtin.js";
import { mcpRetriever } from "./mcp.js";
import { tiresiasPolicy } from "./tiresias.js";
import { httpSink } from "./http-sink.js";
import loreJson from "../../knowledge/lore.js";
export function buildExtensions(cfg, env, fetcher, log) {
    const ctx = (timeoutMs) => () => ({ env, fetcher, timeoutMs });
    const policy = cfg.policy.kind === "tiresias" ? tiresiasPolicy(cfg.policy) : builtinPolicy();
    let knowledge;
    if (cfg.knowledge.kind === "local")
        knowledge = localLore(loadLore(loreJson));
    else if (cfg.knowledge.kind === "mcp")
        knowledge = mcpRetriever(cfg.knowledge, ctx(cfg.knowledge.timeoutMs));
    else
        knowledge = noKnowledge();
    const receipts = cfg.receipts.kind === "http" ? httpSink(cfg.receipts, ctx(cfg.receipts.timeoutMs)) : logSink(log);
    return { policy, knowledge, receipts };
}
const PASSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
/** Validate the bundled lore file. A malformed file loads as empty and says so in the log. */
export function loadLore(raw) {
    const out = {};
    const personas = raw?.personas;
    if (typeof personas !== "object" || personas === null)
        return out;
    for (const [pid, list] of Object.entries(personas)) {
        if (!Array.isArray(list))
            continue;
        out[pid] = list.filter((p) => typeof p === "object" && p !== null && typeof p.id === "string" && PASSAGE_ID_RE.test(p.id) && typeof p.source === "string" && p.source.length <= 80 && typeof p.text === "string" && p.text.length <= 2_000);
    }
    return out;
}
export const PASSAGE_CHARS = 400;
/**
 * Retrieved text is untrusted. Each passage is cleaned and capped; a passage that carries an
 * injection shape or a URL, or that would reveal a must_not_reveal entry, is dropped whole.
 */
export function cleanPassages(passages, mustNotReveal, k) {
    const out = [];
    for (const p of passages) {
        if (out.length >= k)
            break;
        if (typeof p?.text !== "string" || typeof p.id !== "string" || typeof p.source !== "string")
            continue;
        const text = sanitize(p.text).slice(0, PASSAGE_CHARS);
        const id = sanitize(p.id).slice(0, 80);
        const source = sanitize(p.source).slice(0, 80);
        if (!text || !PASSAGE_ID_RE.test(id))
            continue;
        const notice = typeof p.notice === "string" ? sanitize(p.notice).slice(0, 200) : "";
        const all = `${text}\n${source}\n${notice}`;
        if (screenInjection(all) || containsUrl(all))
            continue;
        if (mustNotReveal.length && reveals(all, mustNotReveal))
            continue;
        out.push({ id, source, text, ...(notice ? { notice } : {}) });
    }
    return out;
}
export function loreBlock(passages) {
    if (passages.length === 0)
        return "";
    return ["<lore>", ...passages.map((p) => `[${p.id}] (${p.source}${p.notice ? `; ${p.notice}` : ""}) ${p.text}`), "</lore>"].join("\n") + "\n";
}
