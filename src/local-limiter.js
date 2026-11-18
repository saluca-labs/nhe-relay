// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// In-process limiter for self-hosted (Node) deployments. The Cloudflare Worker uses a Durable
// Object for strongly consistent counters; on Node, a single-process Map is equally consistent
// and needs no external store. The core logic (limiter-core.js) is runtime-agnostic: it takes
// any CounterStore. This module provides one, plus pruning, behind the same fetch-style
// interface the Worker entry expects (POST /take with rules as JSON).

import { takeAll } from "./limiter-core.js";

const DAY = 86_400;

/**
 * A Map-backed counter store with the pruning the Durable Object does.
 * One instance per server process. Multi-process deployments need an external store
 * (Redis, SQLite), documented in the spike report.
 */
export class LocalLimiter {
    constructor() {
        this.counts = new Map();
        this.lastPruned = 0;
    }

    get(k) {
        return Promise.resolve(this.counts.get(k));
    }

    put(entries) {
        for (const [k, v] of Object.entries(entries)) this.counts.set(k, v);
        return Promise.resolve();
    }

    list(limit) {
        const out = new Map();
        for (const [k, v] of this.counts) {
            if (out.size >= limit) break;
            out.set(k, v);
        }
        return Promise.resolve(out);
    }

    delete(keys) {
        for (const k of keys) this.counts.delete(k);
        return Promise.resolve();
    }

    /** Prune windows older than two days, at most once an hour. */
    prune(now) {
        if (now - this.lastPruned <= 3_600_000) return;
        const cutoff = Math.floor(now / 1000) - 2 * DAY;
        for (const k of this.counts.keys()) {
            const start = Number(k.split("|")[2]);
            if (Number.isFinite(start) && start < cutoff) this.counts.delete(k);
        }
        this.lastPruned = now;
    }

    async take(rules) {
        const now = Date.now();
        const result = await takeAll(this, rules, now);
        this.prune(now);
        return result;
    }

    /** fetch-style interface, so the Worker entry can use it as a drop-in stub. */
    async fetch(request) {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/take")
            return new Response("not found", { status: 404 });
        let rules;
        try {
            rules = await request.json();
        } catch {
            return Response.json({ ok: false, refused: "rules_unreadable" });
        }
        if (!Array.isArray(rules))
            return Response.json({ ok: false, refused: "rules_unreadable" });
        return Response.json(await this.take(rules));
    }
}
