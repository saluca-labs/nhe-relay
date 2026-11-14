// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

import { describe, it, expect } from "vitest";
import { canonical, genesis, nextRoot, memoryDigest, issueReceipt, checkReceipt, sha256Hex, fromHex, CanonicalError, type TurnRecord } from "../src/chain";
import { HMAC } from "./helpers";

const enc = new TextEncoder();

describe("canonical JSON (RFC 8785 rules for our value domain)", () => {
  it("sorts keys by UTF-16 code units and drops whitespace", () => {
    expect(canonical({ b: 1, a: [true, null, "x"], A: {} })).toBe('{"A":{},"a":[true,null,"x"],"b":1}');
  });
  it("sorts by code unit, not locale (RFC 8785 3.2.3 example order)", () => {
    // "\u20ac" (euro) sorts after "\r" and "1" and before the surrogate pair key.
    const o = { "\u20ac": 1, "\r": 2, "1": 3, "\ud83d\ude00": 4, "\u0080": 5, "\u00f6": 6 };
    expect(canonical(o)).toBe('{"\\r":2,"1":3,"\u0080":5,"\u00f6":6,"\u20ac":1,"\ud83d\ude00":4}');
  });
  it("writes non-ASCII as raw UTF-8 and escapes only what JSON requires", () => {
    expect(canonical("caf\u00e9 \"q\" \u0001")).toBe('"caf\u00e9 \\"q\\" \\u0001"');
  });
  it("refuses non-integers and lone surrogates instead of normalising them", () => {
    expect(() => canonical(1.5)).toThrow(CanonicalError);
    expect(() => canonical("\ud800")).toThrow(CanonicalError);
  });
});

describe("hash chain", () => {
  const turn = (i: number, npc: string): TurnRecord => ({ v: 1, persona_id: "p-1", session_id: "s-12345678", turn_index: i, player_text: "hi", npc_text: npc, memory_sha256: "0".repeat(64), scene_sha256: null, knowledge_sha256: null });

  it("recomputes as sha256 over the previous root bytes then the canonical turn", async () => {
    const g = await genesis("p-1", "s-12345678");
    const t = turn(1, "hello");
    const prev = fromHex(g);
    const body = enc.encode(canonical(t));
    const buf = new Uint8Array(prev.length + body.length);
    buf.set(prev);
    buf.set(body, prev.length);
    expect(await nextRoot(g, t)).toBe(await sha256Hex(buf));
  });
  it("an edited earlier turn changes every later root", async () => {
    const g = await genesis("p-1", "s-12345678");
    const r1 = await nextRoot(g, turn(1, "hello"));
    const r2 = await nextRoot(r1, turn(2, "again"));
    const r1x = await nextRoot(g, turn(1, "hellO"));
    const r2x = await nextRoot(r1x, turn(2, "again"));
    expect(r2x).not.toBe(r2);
  });
  it("genesis depends on persona and session", async () => {
    expect(await genesis("p-1", "s-12345678")).not.toBe(await genesis("p-2", "s-12345678"));
    expect(await genesis("p-1", "s-12345678")).not.toBe(await genesis("p-1", "s-12345679"));
  });
});

describe("receipt", () => {
  it("verifies what it issued and nothing else", async () => {
    const f = { persona_id: "p-1", session_id: "s-12345678", state_root: "a".repeat(64), turn_count: 3, memory_sha256: await memoryDigest({ summary: "x", facts: [], turn_count: 3 }) };
    const r = await issueReceipt(HMAC, f);
    expect(await checkReceipt(HMAC, f, r)).toBe(true);
    expect(await checkReceipt(HMAC, { ...f, turn_count: 4 }, r)).toBe(false);
    expect(await checkReceipt(HMAC, { ...f, memory_sha256: "b".repeat(64) }, r)).toBe(false);
    expect(await checkReceipt(HMAC + "x", f, r)).toBe(false);
    expect(await checkReceipt(HMAC, f, "zz")).toBe(false);
    expect(await checkReceipt(HMAC, f, undefined)).toBe(false);
  });
});
