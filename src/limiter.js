// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// The Durable Object that hosts the counters. The logic is in limiter-core.js.
// It speaks plain fetch (POST /take with the rules as JSON), so it imports nothing from the
// runtime and the same module loads in Node for the tests.

import { takeAll } from "./limiter-core.js";

const DAY = 86_400;

export class Limiter {
    /**
     * @param {{ storage: { get(k: string): Promise<unknown>, put(k: string | Record<string, unknown>, v?: unknown): Promise<void>, list(o: { limit: number }): Promise<Map<string, unknown>>, delete(keys: string[]): Promise<unknown> } }} state
     */
    constructor(state) {
        this.state = state;
    }

    /** @param {Request} request */
    async fetch(request) {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/take")
            return new Response("not found", { status: 404 });
        let rules;
        try {
            rules = await request.json();
        }
        catch {
            return Response.json({ ok: false, refused: "rules_unreadable" });
        }
        if (!Array.isArray(rules))
            return Response.json({ ok: false, refused: "rules_unreadable" });
        return Response.json(await this.take(rules));
    }

    /** @param {import("./limiter-core.js").Rule[]} rules */
    async take(rules) {
        const storage = this.state.storage;
        const store = {
            get: (/** @type {string} */ k) => /** @type {Promise<number | undefined>} */ (storage.get(k)),
            put: (/** @type {Record<string, number>} */ e) => storage.put(e),
        };
        const now = Date.now();
        const result = await takeAll(store, rules, now);
        // Prune windows older than two days, at most once an hour.
        const last = /** @type {number | undefined} */ (await storage.get("__pruned")) ?? 0;
        if (now - last > 3_600_000) {
            const cutoff = Math.floor(now / 1000) - 2 * DAY;
            const all = await storage.list({ limit: 5_000 });
            const stale = [];
            for (const k of all.keys()) {
                const start = Number(k.split("|")[2]);
                if (Number.isFinite(start) && start < cutoff)
                    stale.push(k);
            }
            for (let i = 0; i < stale.length; i += 128)
                await storage.delete(stale.slice(i, i + 128));
            await storage.put("__pruned", now);
        }
        return result;
    }
}
