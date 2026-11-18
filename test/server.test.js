// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

import { describe, it, expect } from "./expect.js";
import { buildEnv, makeLimiterBinding, toRequest, createServer } from "../host/server.js";
import { LocalLimiter } from "../src/local-limiter.js";
import { genesis } from "../src/chain.js";
import { env as testEnv, HMAC } from "./helpers.js";

describe("local limiter", () => {
    it("counts and refuses identically to the core logic (no Durable Object needed)", async () => {
        const lim = new LocalLimiter();
        const rules = [{ key: "test_day", limit: 2, windowSec: 86_400 }];
        expect((await lim.take(rules)).ok).toBe(true);
        expect((await lim.take(rules)).ok).toBe(true);
        expect((await lim.take(rules)).ok).toBe(false);
    });
    it("isolates windows by key: two different keys count independently", async () => {
        const lim = new LocalLimiter();
        const a = [{ key: "emp-a", limit: 1, windowSec: 86_400 }];
        const b = [{ key: "emp-b", limit: 1, windowSec: 86_400 }];
        expect((await lim.take(a)).ok).toBe(true);
        expect((await lim.take(b)).ok).toBe(true); // different key, independent
        expect((await lim.take(a)).ok).toBe(false); // same key, exhausted
    });
});

describe("env mapping", () => {
    it("maps process.env strings into the env object verbatim", () => {
        const e = buildEnv({ RELAY_ENABLED: "yes", RELAY_HMAC_KEY: HMAC, LLM_KEY: "x" });
        expect(e.RELAY_ENABLED).toBe("yes");
        expect(e.RELAY_HMAC_KEY).toBe(HMAC);
        expect(e.LLM_KEY).toBe("x");
    });
    it("drops non-string values (undefined from deleted env vars)", () => {
        const e = buildEnv({ FOO: "bar", BAZ: undefined });
        expect(e.FOO).toBe("bar");
        expect(e.BAZ).toBeUndefined();
    });
});

describe("limiter binding", () => {
    it("provides a get().fetch() interface the Worker entry can call", async () => {
        const lim = new LocalLimiter();
        const binding = makeLimiterBinding(lim);
        const stub = binding.get(binding.idFromName("global"));
        const r = await stub.fetch("https://limiter/take", {
            method: "POST",
            body: JSON.stringify([{ key: "x", limit: 1, windowSec: 60 }]),
        });
        const body = await r.json();
        expect(body.ok).toBe(true);
    });
});

describe("Node server end-to-end", () => {
    it("serves /health and /v1/genesis over real HTTP on localhost", async () => {
        const lim = new LocalLimiter();
        const { server, port, env: srvEnv } = createServer({
            port: 0, // let the OS pick a free port
            host: "127.0.0.1",
            env: testEnv(),
            limiter: lim,
        });

        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address();
        const base = `http://127.0.0.1:${addr.port}`;

        // /health
        let resp = await fetch(`${base}/health`);
        let body = await resp.json();
        expect(body.service).toBe("nhe-relay");
        expect(body.enabled).toBe(true);

        // /v1/genesis
        resp = await fetch(`${base}/v1/genesis?persona_id=test-npc-fixture&session_id=session-abc123`);
        body = await resp.json();
        expect(body.state_root).toMatch(/^[0-9a-f]{64}$/);
        expect(body.state_root).toBe(await genesis("test-npc-fixture", "session-abc123"));

        server.close();
    });

    it("rejects a turn when the kill switch is off (RELAY_ENABLED != yes)", async () => {
        const lim = new LocalLimiter();
        const { server } = createServer({
            port: 0,
            host: "127.0.0.1",
            env: testEnv({ RELAY_ENABLED: "no" }),
            limiter: lim,
        });

        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address();
        const base = `http://127.0.0.1:${addr.port}`;

        const resp = await fetch(`${base}/v1/turn`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                persona_id: "test-npc-fixture",
                session_id: "session-abc123",
                player_text: "Hello.",
                memory: { summary: "", facts: [], turn_count: 0 },
                state_root: await genesis("test-npc-fixture", "session-abc123"),
            }),
        });
        const body = await resp.json();
        expect(body.fallback).toBe(true);
        expect(body.reason).toBe("kill_switch");

        server.close();
    });
});
