// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// T1.00: Receipts into the audit chain. The relay emits a receipt after every turn through its
// receipt sink extension. This test suite validates that:
//
//   1. Consecutive receipts from the same session form a hash-linked chain: the prev_root of
//      receipt N+1 equals the state_root of receipt N.
//   2. A gap in the chain (a missing receipt) is detectable: prev_root does not match.
//   3. The receipt body never carries player text, reply text, or the raw session id.
//   4. The state_roots in receipts match the state_roots returned to the client.

import { describe, it, expect } from "./expect.js";
import { handleTurn } from "../src/relay.js";
import { genesis, nextRoot, memoryDigest } from "../src/chain.js";
import { env, deps, modelReply, firstTurn, config, SESSION, HMAC } from "./helpers.js";

const IP = "203.0.113.30";

describe("receipt audit chain", () => {
    it("consecutive turn receipts form a hash-linked chain via prev_root -> state_root", async () => {
        const receipts = [];
        // Custom receipt sink that collects every receipt.
        const sink = {
            kind: "test-collector",
            emit: async (r) => { receipts.push(r); },
        };
        const { fetcher } = modelReply({ say: "Hello.", remember: ["likes coffee"], summary: "A visitor." });
        const d = deps({
            fetcher,
            config: config({ receipts: { kind: "log" } }),
            extensions: { policy: { kind: "builtin", decide: async () => ({ allow: true }), onReceipt: async () => {} }, knowledge: { kind: "none", retrieve: async () => [] }, receipts: sink },
        });

        // Turn 1
        const t1 = await firstTurn("Hello, I am Sam.");
        const r1 = await handleTurn(t1, IP, env(), d);
        expect(r1.body.fallback).toBe(false);

        // Turn 2
        const r2 = await handleTurn(
            { persona_id: "test-npc-fixture", session_id: SESSION, player_text: "More tea please.",
              memory: r1.body.memory, state_root: r1.body.state_root, receipt: r1.body.receipt },
            IP, env(), d,
        );
        expect(r2.body.fallback).toBe(false);

        // Two receipts collected.
        expect(receipts.length).toBe(2);
        expect(receipts[0].kind).toBe("turn");
        expect(receipts[1].kind).toBe("turn");

        // The chain links: receipt[1].prev_root == receipt[0].state_root.
        expect(receipts[1].prev_root).toBe(receipts[0].state_root);
        // And both match what the client received.
        expect(receipts[0].state_root).toBe(r1.body.state_root);
        expect(receipts[1].state_root).toBe(r2.body.state_root);
        // Turn indices advance.
        expect(receipts[0].turn_index).toBe(1);
        expect(receipts[1].turn_index).toBe(2);
    });

    it("a missing receipt in the chain is detectable: prev_root breaks", async () => {
        const receipts = [];
        const sink = {
            kind: "test-collector",
            emit: async (r) => { receipts.push(r); },
        };
        const { fetcher } = modelReply({ say: "Hi.", remember: ["new"], summary: "S." });
        const d = deps({
            fetcher,
            config: config(),
            extensions: { policy: { kind: "builtin", decide: async () => ({ allow: true }), onReceipt: async () => {} }, knowledge: { kind: "none", retrieve: async () => [] }, receipts: sink },
        });

        // Three turns.
        const r1 = await handleTurn(await firstTurn("One."), IP, env(), d);
        const r2 = await handleTurn(
            { persona_id: "test-npc-fixture", session_id: SESSION, player_text: "Two.",
              memory: r1.body.memory, state_root: r1.body.state_root, receipt: r1.body.receipt },
            IP, env(), d,
        );
        const r3 = await handleTurn(
            { persona_id: "test-npc-fixture", session_id: SESSION, player_text: "Three.",
              memory: r2.body.memory, state_root: r2.body.state_root, receipt: r2.body.receipt },
            IP, env(), d,
        );

        expect(receipts.length).toBe(3);

        // Simulate a gap: drop receipt[1] (turn 2). Now receipt[2].prev_root != receipt[0].state_root.
        const gapped = [receipts[0], receipts[2]];
        const links = gapped[1].prev_root === gapped[0].state_root;
        expect(links).toBe(false); // the chain is broken by the gap
    });

    it("receipts never carry player text, reply text, or the raw session id", async () => {
        const receipts = [];
        const sink = {
            kind: "test-collector",
            emit: MyFunction,
        };
        async function MyFunction(r) { receipts.push(r); }

        const { fetcher } = modelReply({ say: "Welcome.", remember: ["secret fact"], summary: "Has a secret." });
        const d = deps({
            fetcher,
            config: config(),
            extensions: { policy: { kind: "builtin", decide: async () => ({ allow: true }), onReceipt: async () => {} }, knowledge: { kind: "none", retrieve: async () => [] }, receipts: sink },
        });

        await handleTurn(await firstTurn("My password is swordfish."), IP, env(), d);

        expect(receipts.length).toBe(1);
        const serialized = JSON.stringify(receipts[0]);
        // No player text, no reply text, no raw session id.
        expect(serialized).not.toContain("swordfish");
        expect(serialized).not.toContain("Welcome");
        expect(serialized).not.toContain(SESSION);
        // The session is hashed, not raw.
        expect(receipts[0].session_hash).toMatch(/^[0-9a-f]+$/);
    });

    it("receipts from different sessions do not chain into each other", async () => {
        const receipts = [];
        const sink = {
            kind: "test-collector",
            emit: async (r) => { receipts.push(r); },
        };
        const { fetcher } = modelReply({ say: "Hi.", remember: ["x"], summary: "S." });
        const d = deps({
            fetcher,
            config: config(),
            extensions: { policy: { kind: "builtin", decide: async () => ({ allow: true }), onReceipt: async () => {} }, knowledge: { kind: "none", retrieve: async () => [] }, receipts: sink },
        });

        const S1 = "session-audit-aaa";
        const S2 = "session-audit-bbb";

        const r1 = await handleTurn(await firstTurn("A1.", "test-npc-fixture"), IP, env(), d);
        // Override firstTurn's session by creating a custom one.
        const t2 = { persona_id: "test-npc-fixture", session_id: S2, player_text: "B1.",
                     memory: { summary: "", facts: [], turn_count: 0 },
                     state_root: await genesis("test-npc-fixture", S2) };
        const r2 = await handleTurn(t2, IP, env(), d);

        expect(receipts.length).toBe(2);
        // Different session hashes.
        expect(receipts[0].session_hash).not.toBe(receipts[1].session_hash);
        // No chain link between them (different sessions).
        expect(receipts[1].prev_root).not.toBe(receipts[0].state_root);
    });
});
