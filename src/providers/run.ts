// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Runs a provider chain in order inside one time budget. For each provider:
//   1. stop if the budget has less than 500 ms left;
//   2. ask the policy extension (default: allow), then reserve its worst-case cost against the daily spend ceiling (the cost-ceiling hook);
//      a refused reservation skips that provider, it never runs unpaid-for;
//   3. call it with min(its timeout, budget left);
//   4. ask `accept` whether the result is usable; if not, try the next provider.
// Every attempt is recorded with a short outcome, never with the content.

import { ProviderError, type CallContext, type FetchLike, type ProviderEnv } from "./types";
import type { LlmProvider, LlmRequest, SttProvider, SttRequest, TtsProvider, TtsRequest, TtsAudio } from "./types";

export interface Attempt {
  id: string;
  kind: string;
  model: string;
  outcome: string;
  ms: number;
}

export interface ChainResult<T> {
  ok: boolean;
  value?: T;
  provider?: { id: string; kind: string; model: string };
  attempts: Attempt[];
}

/** Reserve micro-dollars against the daily ceiling. Resolves true when admitted. */
export type SpendHook = (micros: number) => Promise<boolean>;

/** The policy extension point, asked before the spend reservation. */
export type PolicyHook = (p: { provider_id: string; provider_kind: string; model: string; estimate_micros: number }) => Promise<{ allow: boolean; reason?: string }>;

export interface ChainDeps {
  policy?: PolicyHook;
  env: ProviderEnv;
  fetcher: FetchLike;
  spend: SpendHook;
  now: () => number;
  budgetMs: number;
}

interface Runnable<Req, Out> {
  id: string;
  kind: string;
  model: string;
  timeoutMs: number;
  estimateMicros(req: Req): number;
  run(req: Req, ctx: CallContext): Promise<Out>;
}

export async function runChain<Req, Out>(chain: Runnable<Req, Out>[], req: Req, deps: ChainDeps, accept: (out: Out) => boolean = () => true): Promise<ChainResult<Out>> {
  const t0 = deps.now();
  const attempts: Attempt[] = [];
  let rejected: { value: Out; p: Runnable<Req, Out> } | null = null;
  for (const p of chain) {
    const left = deps.budgetMs - (deps.now() - t0);
    if (left < 500) break;
    const s = deps.now();
    const rec = (outcome: string) => attempts.push({ id: p.id, kind: p.kind, model: p.model, outcome, ms: deps.now() - s });

    let micros: number;
    try {
      micros = p.estimateMicros(req);
    } catch {
      rec("estimate_failed");
      continue;
    }
    if (!Number.isSafeInteger(micros) || micros < 0) {
      rec("estimate_unreadable"); // cannot tell what it costs: it does not run
      continue;
    }
    if (deps.policy) {
      let d: { allow: boolean; reason?: string };
      try {
        d = await deps.policy({ provider_id: p.id, provider_kind: p.kind, model: p.model, estimate_micros: micros });
      } catch {
        d = { allow: false, reason: "unreadable" }; // a policy that cannot answer cannot say yes
      }
      if (d.allow !== true) {
        rec("policy_deny");
        continue;
      }
    }
    if (micros > 0) {
      let admitted = false;
      try {
        admitted = await deps.spend(micros);
      } catch {
        admitted = false;
      }
      if (!admitted) {
        rec("spend_ceiling");
        continue;
      }
    }

    try {
      const out = await p.run(req, { env: deps.env, fetcher: deps.fetcher, timeoutMs: Math.min(p.timeoutMs, left) });
      if (!accept(out)) {
        rec("rejected");
        rejected = { value: out, p };
        continue;
      }
      rec("ok");
      return { ok: true, value: out, provider: { id: p.id, kind: p.kind, model: p.model }, attempts };
    } catch (e) {
      rec(e instanceof ProviderError ? e.kind : "upstream");
    }
  }
  // Nothing accepted but something answered: hand it back so the caller refuses it by its own rule.
  if (rejected) return { ok: true, value: rejected.value, provider: { id: rejected.p.id, kind: rejected.p.kind, model: rejected.p.model }, attempts };
  return { ok: false, attempts };
}

// Adapters expose complete / transcribe / synthesize; these wrap them as Runnables.

export const asLlm = (p: LlmProvider): Runnable<LlmRequest, string> => ({ ...p, run: (r, c) => p.complete(r, c) });
export const asStt = (p: SttProvider): Runnable<SttRequest, string> => ({ ...p, run: (r, c) => p.transcribe(r, c) });
export const asTts = (p: TtsProvider): Runnable<TtsRequest, TtsAudio> => ({ ...p, run: (r, c) => p.synthesize(r, c) });
