// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Fixed-window counters held in ONE Durable Object, so every check is strongly consistent
// (KV is eventually consistent and cannot count). Attempts are counted before any provider call.
// All windows are checked first; only if every one has room are all incremented.
// A rule's weight is 1 for a request count, or a cost in micro-dollars for the spend ceiling.

export interface Rule {
  key: string;
  limit: number;
  windowSec: number;
  weight?: number;
}

export type TakeResult = { ok: true } | { ok: false; refused: string };

export interface CounterStore {
  get(key: string): Promise<number | undefined>;
  put(entries: Record<string, number>): Promise<void>;
}

export function windowKey(rule: Rule, nowMs: number): string {
  const start = Math.floor(nowMs / 1000 / rule.windowSec) * rule.windowSec;
  return `${rule.key}|${rule.windowSec}|${start}`;
}

export async function takeAll(store: CounterStore, rules: Rule[], nowMs: number): Promise<TakeResult> {
  const keys = rules.map((r) => windowKey(r, nowMs));
  const counts: number[] = [];
  for (let i = 0; i < rules.length; i++) {
    const w = rules[i].weight ?? 1;
    if (!Number.isSafeInteger(w) || w < 0) return { ok: false, refused: "weight_unreadable" };
    const n = await store.get(keys[i]);
    if (n !== undefined && (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)) {
      return { ok: false, refused: "counter_unreadable" }; // cannot tell is a refusal
    }
    const c = n ?? 0;
    if (c + w > rules[i].limit) return { ok: false, refused: rules[i].key.split(":")[0] };
    counts.push(c);
  }
  const writes: Record<string, number> = {};
  keys.forEach((k, i) => (writes[k] = counts[i] + (rules[i].weight ?? 1)));
  await store.put(writes);
  return { ok: true };
}
