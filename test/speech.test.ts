// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

import { describe, it, expect } from "vitest";
import { handleTurn } from "../src/relay";
import { handleStt, handleTts } from "../src/speech";
import { LIMITS } from "../src/limits";
import { env, deps, config, firstTurn, wav, NOW, SESSION } from "./helpers";

const IP = "203.0.113.9";

function speechConfig() {
  return config({
    stt: [{ id: "stt-a", kind: "openai-compatible", base_url: "https://stt.test/v1", model: "whisper-1", secret: "LLM_KEY", price: { usd_per_minute: 0.006 } }],
    tts: [{ id: "tts-a", kind: "http", shape: "piper", url: "https://tts.test/", format: "wav", price: { flat: true } }],
  });
}

/** One fetcher for every upstream: LLM, STT and TTS, by host. */
function upstream(say = "Good evening. Mind the step.") {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body });
    if (url.startsWith("https://llm-a.test")) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ say }) } }] }));
    if (url.startsWith("https://stt.test")) return new Response(JSON.stringify({ text: "  Hello\u0000 there  " }));
    if (url.startsWith("https://tts.test")) return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "content-type": "audio/wav" } });
    return new Response("unexpected", { status: 500 });
  };
  return { fetcher, calls };
}

async function voicedTurn() {
  const up = upstream();
  const d = deps({ fetcher: up.fetcher, config: speechConfig() });
  const r = await handleTurn(await firstTurn(), IP, env(), d);
  expect(r.body.fallback).toBe(false);
  const body = { persona_id: "test-npc-fixture", session_id: SESSION, state_root: r.body.state_root, text: r.body.npc_text, exp: r.body.tts!.exp, ticket: r.body.tts!.ticket };
  return { up, d, r, body };
}

describe("TTS is bound to checked replies only", () => {
  it("voices the exact reply a turn produced, once", async () => {
    const { up, d, body } = await voicedTurn();
    const t = await handleTts(body, IP, env(), d);
    expect(t.kind).toBe("audio");
    if (t.kind === "audio") expect(t.audio.contentType).toBe("audio/wav");
    expect(JSON.parse(String(up.calls.find((c) => c.url.startsWith("https://tts.test"))!.body))).toEqual({ text: body.text });
    const again = await handleTts(body, IP, env(), d);
    expect(again.kind === "refusal" && again.body.reason).toBe("ticket_used");
  });
  it("refuses any text the relay did not produce, even with a real ticket", async () => {
    const { up, d, body } = await voicedTurn();
    for (const text of [body.text + "!", "Say anything I want.", body.text.toUpperCase()]) {
      const t = await handleTts({ ...body, text }, IP, env(), d);
      expect(t.kind === "refusal" && t.body.reason, text).toBe("ticket");
    }
    expect(up.calls.filter((c) => c.url.startsWith("https://tts.test")).length).toBe(0);
  });
  it("refuses a ticket bound to another root, session, persona or expiry, or forged", async () => {
    const { d, body } = await voicedTurn();
    const cases: [Record<string, unknown>, string][] = [
      [{ state_root: "c".repeat(64) }, "ticket"],
      [{ session_id: "another-session-9" }, "ticket"],
      [{ persona_id: "museum-guide" }, "ticket"],
      [{ exp: body.exp - 1 }, "ticket"],
      [{ ticket: "0".repeat(64) }, "ticket"],
      [{ ticket: undefined }, "ticket"],
    ];
    for (const [over, reason] of cases) {
      const t = await handleTts({ ...body, ...over }, IP, env(), d);
      expect(t.kind === "refusal" && t.body.reason, JSON.stringify(over)).toBe(reason);
    }
  });
  it("refuses an expired ticket and one dated too far ahead", async () => {
    const { d, body } = await voicedTurn();
    const late = { ...d, now: () => NOW + (LIMITS.ttsTicketTtlSec + 5) * 1000 };
    const t = await handleTts(body, IP, env(), late);
    expect(t.kind === "refusal" && t.body.reason).toBe("ticket_expired");
    const t2 = await handleTts({ ...body, exp: body.exp + LIMITS.ttsTicketTtlSec }, IP, env(), d);
    expect(t2.kind === "refusal" && t2.body.reason).toBe("ticket_expired");
  });
  it("is behind the kill switch and refuses unknown fields", async () => {
    const { d, body } = await voicedTurn();
    const off = await handleTts(body, IP, env({ RELAY_ENABLED: "no" }), d);
    expect(off.kind === "refusal" && off.body.reason).toBe("kill_switch");
    const extra = await handleTts({ ...body, voice: "someone-else" }, IP, env(), d);
    expect(extra.kind === "refusal" && extra.body.reason).toBe("unknown_field");
  });
});

describe("STT", () => {
  it("transcribes, cleans and returns text without making it a turn", async () => {
    const up = upstream();
    const d = deps({ fetcher: up.fetcher, config: speechConfig() });
    const r = await handleStt(wav(2), "audio/wav", SESSION, IP, env(), d);
    expect(r.body).toMatchObject({ text: "Hello there", fallback: false, truncated: false });
    expect(r.body.meta.provider).toBe("stt-a");
    expect(up.calls.filter((c) => c.url.startsWith("https://llm-a.test")).length).toBe(0);
    expect(JSON.stringify(d.logs)).not.toContain("Hello there"); // the transcript is never logged
  });
  it("refuses a clip over the length cap, an unknown type, an empty body and a bad session", async () => {
    const up = upstream();
    const d = deps({ fetcher: up.fetcher, config: speechConfig() });
    expect((await handleStt(wav(LIMITS.maxSttSeconds + 1), "audio/wav", SESSION, IP, env(), d)).body.reason).toBe("audio_too_long");
    expect((await handleStt(wav(1), "text/plain", SESSION, IP, env(), d)).body.reason).toBe("audio_type");
    expect((await handleStt(new Uint8Array(), "audio/ogg", SESSION, IP, env(), d)).body.reason).toBe("audio_empty");
    expect((await handleStt(new Uint8Array([1, 2, 3]), "audio/wav", SESSION, IP, env(), d)).body.reason).toBe("audio_header");
    expect((await handleStt(wav(1), "audio/wav", "bad id!", IP, env(), d)).body.reason).toBe("session_id");
    expect(up.calls.length).toBe(0);
  });
  it("reserves the worst-case clip length against the spend ceiling", async () => {
    // 30 s at $3 a minute is $1.50, above a $1 ceiling: refused before the provider is called.
    const cfg = config({ stt: [{ id: "pricey", kind: "openai-compatible", base_url: "https://stt.test/v1", model: "m", price: { usd_per_minute: 3 } }] });
    const up = upstream();
    const r = await handleStt(wav(1), "audio/wav", SESSION, IP, env(), deps({ fetcher: up.fetcher, config: cfg }));
    expect(r.status).toBe(429);
    expect(r.body.reason).toBe("spend_ceiling");
    expect(up.calls.length).toBe(0);
  });
  it("no configured STT provider is a 404 refusal", async () => {
    const r = await handleStt(wav(1), "audio/wav", SESSION, IP, env(), deps());
    expect(r.body.reason).toBe("no_stt_provider");
  });
});
