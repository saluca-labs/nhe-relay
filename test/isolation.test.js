// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// T1.00: Multi-employee isolation. In the per-employee agent product, each employee has their
// own agent (a persona in the relay). This test suite validates that two employees are isolated:
//
//   1. Chain isolation: employee A cannot use employee B's receipt to advance a turn.
//   2. Limiter isolation: employee A's rate limit does not consume employee B's budget.
//   3. MCP knowledge grants: persona A retrieves from mindset "set-a", persona B from "set-b".
//      The MCP retriever's persona_args must produce different arguments per persona.

import { describe, it, expect } from "./expect.js";
import { handleTurn } from "../src/relay.js";
import { genesis, nextRoot } from "../src/chain.js";
import { takeAll } from "../src/limiter-core.js";
import { mcpRetriever } from "../src/extensions/mcp.js";
import { env, deps, mapStore, modelReply, firstTurn, config, SESSION, HMAC } from "./helpers.js";

const IP_A = "203.0.113.10";
const IP_B = "203.0.113.20";
const SESSION_A = "session-emp-a-001";
const SESSION_B = "session-emp-b-002";

async function firstTurnEmp(text, persona, session) {
    return {
        persona_id: persona,
        session_id: session,
        player_text: text,
        memory: { summary: "", facts: [], turn_count: 0 },
        state_root: await genesis(persona, session),
    };
}

// Two employee personas. In the real product these come from the registry; here we reuse the
// test fixture because the relay resolves personas server-side and the fixture is valid.
const PERSONA = "test-npc-fixture";

describe("chain isolation between employees", () => {
    it("employee A cannot use employee B's receipt on a later turn", async () => {
        const d = deps();
        // Employee A takes turn 1 and gets a receipt.
        const tA = await firstTurnEmp("Hello from A.", PERSONA, SESSION_A);
        const rA = await handleTurn(tA, IP_A, env(), d);
        expect(rA.body.fallback).toBe(false);

        // Employee B takes turn 1 and gets their own receipt and state.
        const tB = await firstTurnEmp("Hello from B.", PERSONA, SESSION_B);
        const rB = await handleTurn(tB, IP_B, env(), d);
        expect(rB.body.fallback).toBe(false);

        // Employee B tries to use A's receipt on their turn 2, with B's own state_root and memory.
        const rB2 = await handleTurn(
            {
                persona_id: PERSONA,
                session_id: SESSION_B,
                player_text: "Using A's receipt.",
                memory: rB.body.memory,
                state_root: rB.body.state_root,
                receipt: rA.body.receipt, // A's receipt, not B's
            },
            IP_B, env(), d,
        );
        expect(rB2.body.fallback).toBe(true);
        expect(rB2.body.reason).toBe("chain_receipt");
    });

    it("employee A's state root does not chain into employee B's session", async () => {
        const d = deps();
        const tA = await firstTurnEmp("Hello from A.", PERSONA, SESSION_A);
        const rA = await handleTurn(tA, IP_A, env(), d);
        expect(rA.body.fallback).toBe(false);

        // B tries to continue from A's state_root and memory with A's receipt (full identity swap).
        const rB = await handleTurn(
            {
                persona_id: PERSONA,
                session_id: SESSION_B,
                player_text: "Following A's chain.",
                memory: rA.body.memory,
                state_root: rA.body.state_root,
                receipt: rA.body.receipt,
            },
            IP_B, env(), d,
        );
        // The receipt was issued for session_A, not session_B, so it fails.
        expect(rB.body.fallback).toBe(true);
        expect(rB.body.reason).toBe("chain_receipt");
    });

    it("two employees can run independent chains simultaneously without interference", async () => {
        const d = deps();
        // A turn 1
        const rA1 = await handleTurn(await firstTurnEmp("A turn 1.", PERSONA, SESSION_A), IP_A, env(), d);
        expect(rA1.body.fallback).toBe(false);
        // B turn 1
        const rB1 = await handleTurn(await firstTurnEmp("B turn 1.", PERSONA, SESSION_B), IP_B, env(), d);
        expect(rB1.body.fallback).toBe(false);
        // A turn 2 (uses A's receipt)
        const rA2 = await handleTurn(
            { persona_id: PERSONA, session_id: SESSION_A, player_text: "A turn 2.",
              memory: rA1.body.memory, state_root: rA1.body.state_root, receipt: rA1.body.receipt },
            IP_A, env(), d,
        );
        expect(rA2.body.fallback).toBe(false);
        expect(rA2.body.memory.turn_count).toBe(2);
        // B turn 2 (uses B's receipt)
        const rB2 = await handleTurn(
            { persona_id: PERSONA, session_id: SESSION_B, player_text: "B turn 2.",
              memory: rB1.body.memory, state_root: rB1.body.state_root, receipt: rB1.body.receipt },
            IP_B, env(), d,
        );
        expect(rB2.body.fallback).toBe(false);
        expect(rB2.body.memory.turn_count).toBe(2);
        // The chains are independent: A's root at turn 2 != B's root at turn 2.
        expect(rA2.body.state_root).not.toBe(rB2.body.state_root);
    });
});

describe("limiter isolation between employees", () => {
    it("employee A exhausting their session limit does not block employee B", async () => {
        const sharedStore = mapStore();

        // Narrowed to 1 turn per session per day for the test.
        const envNarrow = env({ SESSION_PER_DAY: "1" });

        // A's first turn passes.
        const dA = deps({ config: config(), now: () => 1_700_000_000_000 }, sharedStore);
        const tA = await firstTurnEmp("Hello A.", PERSONA, SESSION_A);
        const rA1 = await handleTurn(tA, IP_A, envNarrow, dA);
        expect(rA1.body.fallback).toBe(false);

        // A's second turn is rate-limited (session_per_day = 1).
        const rA2 = await handleTurn(
            { persona_id: PERSONA, session_id: SESSION_A, player_text: "Again A.",
              memory: rA1.body.memory, state_root: rA1.body.state_root, receipt: rA1.body.receipt },
            IP_A, envNarrow, dA,
        );
        expect(rA2.body.fallback).toBe(true);
        expect(rA2.body.reason).toMatch(/^rate_/);

        // B's first turn still passes: different session, different key in the shared store.
        const dB = deps({ config: config(), now: () => 1_700_000_000_000 }, sharedStore);
        const tB = await firstTurnEmp("Hello B.", PERSONA, SESSION_B);
        const rB1 = await handleTurn(tB, IP_B, envNarrow, dB);
        expect(rB1.body.fallback).toBe(false);
    });
});

describe("MCP knowledge grants per persona", () => {
    // A mock MCP server that records which mindset was requested.
    function mockMcpServer() {
        const calls = [];
        const fetcher = async (_url, init) => {
            const body = JSON.parse(String(init.body));
            if (body.method === "notifications/initialized")
                return new Response(null, { status: 202 });
            if (body.method === "initialize") {
                return new Response(JSON.stringify({
                    jsonrpc: "2.0", id: body.id,
                    result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t", version: "1" } },
                }), { headers: { "content-type": "application/json" } });
            }
            // tools/call: record the mindset argument.
            calls.push(body.params.arguments);
            return new Response(JSON.stringify({
                jsonrpc: "2.0", id: body.id,
                result: { content: [{ type: "text", text: "A passage." }] },
            }), { headers: { "content-type": "application/json" } });
        };
        return { fetcher, calls };
    }

    // MCP entry with per-persona mindset grants (the per-agent knowledge grant).
    const entry = {
        kind: "mcp",
        url: "https://kb.example.com/mcp",
        secret: "KB_KEY",
        authScheme: "bearer",
        authHeader: "authorization",
        tool: "recall",
        queryArg: "query",
        kArg: "k",
        personaArg: null,
        fixedArgs: {},
        personaArgs: {
            "emp-a-agent": { mindset: "sales-kb" },
            "emp-b-agent": { mindset: "eng-kb" },
        },
        sourceLabel: "kb",
        timeoutMs: 2000,
    };

    it("persona A retrieves from its granted mindset, persona B from a different one", async () => {
        const { fetcher, calls } = mockMcpServer();
        const ctx = () => ({ env: { KB_KEY: "kb-test-not-real" }, fetcher, timeoutMs: 2000 });
        const k = mcpRetriever(entry, ctx);

        await k.retrieve({ persona_id: "emp-a-agent", query: "quarterly numbers", k: 3 });
        await k.retrieve({ persona_id: "emp-b-agent", query: "deploy pipeline", k: 3 });

        expect(calls.length).toBe(2);
        expect(calls[0].mindset).toBe("sales-kb");
        expect(calls[1].mindset).toBe("eng-kb");
    });

    it("a persona with no explicit grant falls back to fixedArgs only", async () => {
        const { fetcher, calls } = mockMcpServer();
        const ctx = () => ({ env: { KB_KEY: "kb-test-not-real" }, fetcher, timeoutMs: 2000 });
        const k = mcpRetriever(entry, ctx);

        await k.retrieve({ persona_id: "emp-c-agent", query: "general", k: 3 });
        expect(calls[0].mindset).toBeUndefined();
    });

    it("changing the persona_args mapping changes which mindset a persona gets (grant is per-persona, not global)", async () => {
        const { fetcher, calls } = mockMcpServer();
        const ctx = () => ({ env: { KB_KEY: "kb-test-not-real" }, fetcher, timeoutMs: 2000 });
        const revoked = { ...entry, personaArgs: { "emp-a-agent": { mindset: "legal-kb" } } };
        const k = mcpRetriever(revoked, ctx);

        await k.retrieve({ persona_id: "emp-a-agent", query: "contracts", k: 3 });
        expect(calls[0].mindset).toBe("legal-kb");
        expect(calls[0].mindset).not.toBe("sales-kb");
    });
});
