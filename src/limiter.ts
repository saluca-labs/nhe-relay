// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// The Durable Object that hosts the counters. The logic is in limiter-core.ts.

import { DurableObject } from "cloudflare:workers";
import { takeAll, type CounterStore, type Rule, type TakeResult } from "./limiter-core";

const DAY = 86_400;

export class Limiter extends DurableObject {
  async take(rules: Rule[]): Promise<TakeResult> {
    const storage = this.ctx.storage;
    const store: CounterStore = {
      get: (k) => storage.get<number>(k),
      put: (e) => storage.put(e),
    };
    const now = Date.now();
    const result = await takeAll(store, rules, now);
    // Prune windows older than two days, at most once an hour.
    const last = (await storage.get<number>("__pruned")) ?? 0;
    if (now - last > 3_600_000) {
      const cutoff = Math.floor(now / 1000) - 2 * DAY;
      const all = await storage.list<number>({ limit: 5_000 });
      const stale: string[] = [];
      for (const k of all.keys()) {
        const start = Number(k.split("|")[2]);
        if (Number.isFinite(start) && start < cutoff) stale.push(k);
      }
      for (let i = 0; i < stale.length; i += 128) await storage.delete(stale.slice(i, i + 128));
      await storage.put("__pruned", now);
    }
    return result;
  }
}
