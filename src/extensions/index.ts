// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Builds the configured policy, knowledge provider and receipt sink for one request, and holds
// the rules that apply to retrieved text whatever its source.

import type { RelayConfig } from "../config";
import type { CallContext, FetchLike, ProviderEnv } from "../providers/types";
import { sanitize, screenInjection, containsUrl } from "../safety";
import { reveals } from "../scene";
import { builtinPolicy, noKnowledge, localLore, logSink } from "./builtin";
import { mcpRetriever } from "./mcp";
import { tiresiasPolicy } from "./tiresias";
import { httpSink } from "./http-sink";
import type { KnowledgeProvider, Passage, PolicyProvider, ReceiptSink } from "./types";
import loreJson from "../../knowledge/lore.json";

export interface Extensions {
  policy: PolicyProvider;
  knowledge: KnowledgeProvider;
  receipts: ReceiptSink;
}

export function buildExtensions(cfg: RelayConfig, env: ProviderEnv, fetcher: FetchLike, log: (r: Record<string, unknown>) => void): Extensions {
  const ctx = (timeoutMs: number) => (): CallContext => ({ env, fetcher, timeoutMs });
  const policy = cfg.policy.kind === "tiresias" ? tiresiasPolicy(cfg.policy) : builtinPolicy();
  let knowledge: KnowledgeProvider;
  if (cfg.knowledge.kind === "local") knowledge = localLore(loadLore(loreJson));
  else if (cfg.knowledge.kind === "mcp") knowledge = mcpRetriever(cfg.knowledge, ctx(cfg.knowledge.timeoutMs));
  else knowledge = noKnowledge();
  const receipts = cfg.receipts.kind === "http" ? httpSink(cfg.receipts, ctx(cfg.receipts.timeoutMs)) : logSink(log);
  return { policy, knowledge, receipts };
}

const PASSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/** Validate the bundled lore file. A malformed file loads as empty and says so in the log. */
export function loadLore(raw: unknown): Record<string, Passage[]> {
  const out: Record<string, Passage[]> = {};
  const personas = (raw as { personas?: unknown })?.personas;
  if (typeof personas !== "object" || personas === null) return out;
  for (const [pid, list] of Object.entries(personas as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    out[pid] = list.filter(
      (p): p is Passage =>
        typeof p === "object" && p !== null && typeof p.id === "string" && PASSAGE_ID_RE.test(p.id) && typeof p.source === "string" && p.source.length <= 80 && typeof p.text === "string" && p.text.length <= 2_000,
    );
  }
  return out;
}

export const PASSAGE_CHARS = 400;

/**
 * Retrieved text is untrusted. Each passage is cleaned and capped; a passage that carries an
 * injection shape or a URL, or that would reveal a must_not_reveal entry, is dropped whole.
 */
export function cleanPassages(passages: Passage[], mustNotReveal: string[], k: number): Passage[] {
  const out: Passage[] = [];
  for (const p of passages) {
    if (out.length >= k) break;
    if (typeof p?.text !== "string" || typeof p.id !== "string" || typeof p.source !== "string") continue;
    const text = sanitize(p.text).slice(0, PASSAGE_CHARS);
    const id = sanitize(p.id).slice(0, 80);
    const source = sanitize(p.source).slice(0, 80);
    if (!text || !PASSAGE_ID_RE.test(id)) continue;
    const notice = typeof p.notice === "string" ? sanitize(p.notice).slice(0, 200) : "";
    const all = `${text}\n${source}\n${notice}`;
    if (screenInjection(all) || containsUrl(all)) continue;
    if (mustNotReveal.length && reveals(all, mustNotReveal)) continue;
    out.push({ id, source, text, ...(notice ? { notice } : {}) });
  }
  return out;
}

export function loreBlock(passages: Passage[]): string {
  if (passages.length === 0) return "";
  return ["<lore>", ...passages.map((p) => `[${p.id}] (${p.source}${p.notice ? `; ${p.notice}` : ""}) ${p.text}`), "</lore>"].join("\n") + "\n";
}
