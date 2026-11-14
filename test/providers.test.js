// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Every adapter against mocked HTTP (or a mocked Workers AI binding): the request it sends, the
// result it reads, the error kinds it maps, its timeout, and its cost estimate.

import { describe, it, expect } from "./expect.js";
import { ProviderError, costMicros } from "../src/providers/types.js";
import { workersAiLlm } from "../src/providers/llm/workers-ai.js";
import { ollamaCloudLlm, OLLAMA_URL } from "../src/providers/llm/ollama-cloud.js";
import { openRouterLlm, OPENROUTER_URL } from "../src/providers/llm/openrouter.js";
import { anthropicLlm } from "../src/providers/llm/anthropic.js";
import { openAiCompatibleLlm } from "../src/providers/llm/openai-compatible.js";
import { workersAiStt } from "../src/providers/stt/workers-ai.js";
import { deepgramStt } from "../src/providers/stt/deepgram.js";
import { openAiCompatibleStt } from "../src/providers/stt/openai-compatible.js";
import { whisperHttpStt } from "../src/providers/stt/whisper-http.js";
import { workersAiTts } from "../src/providers/tts/workers-ai.js";
import { elevenLabsTts } from "../src/providers/tts/elevenlabs.js";
import { azureTts, xmlEscape } from "../src/providers/tts/azure.js";
import { httpTts } from "../src/providers/tts/http-tts.js";
import { wavFromPcm16 } from "../src/providers/tts/common.js";
import { wavSeconds } from "../src/speech.js";
function mock(respond) {
    const calls = [];
    const fetcher = async (url, init) => {
        calls.push({ url, init });
        return respond(url, init);
    };
    return { fetcher, calls };
}
const hang = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
function ctx(fetcher, env = { KEY: "sk-test-not-real" }, timeoutMs = 2_000) {
    return { env, fetcher, timeoutMs };
}
async function kindOf(p) {
    try {
        await p;
        return "resolved";
    }
    catch (e) {
        return e instanceof ProviderError ? e.kind : `other:${String(e)}`;
    }
}
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });
const flat = { flat: true };
const REQ = { system: "sys", user: "hello", maxOutputTokens: 300 };
describe("HTTP error mapping is the same for every fetch-based adapter", () => {
    const llms = [
        () => ollamaCloudLlm({ id: "o", kind: "ollama-cloud", model: "m", timeoutMs: 2000, price: flat, secret: "KEY" }),
        () => openRouterLlm({ id: "r", kind: "openrouter", model: "m:free", timeoutMs: 2000, price: flat, secret: "KEY", freeOnly: true }),
        () => openAiCompatibleLlm({ id: "c", kind: "openai-compatible", model: "m", timeoutMs: 2000, price: flat, baseUrl: "https://x.test/v1", secret: "KEY", jsonMode: true }),
        () => anthropicLlm({ id: "a", kind: "anthropic", model: "claude-opus-5-5", timeoutMs: 2000, price: flat, secret: "KEY", effort: "low", maxTokens: 2048, fallbacks: true }),
    ];
    const table = [
        [401, "auth"],
        [403, "auth"],
        [429, "rate_limited"],
        [400, "bad_request"],
        [404, "bad_request"],
        [500, "upstream"],
        [503, "upstream"],
    ];
    for (const make of llms) {
        const name = make().kind;
        it(`${name}: status codes map to kinds`, async () => {
            for (const [status, kind] of table) {
                const { fetcher } = mock(() => json({ error: { type: "x", message: "no" } }, status));
                expect(await kindOf(make().complete(REQ, ctx(fetcher))), `${name} ${status}`).toBe(kind);
            }
        });
        it(`${name}: a hung request times out`, async () => {
            const t0 = Date.now();
            expect(await kindOf(make().complete(REQ, ctx(hang, undefined, 300)))).toBe("timeout");
            expect(Date.now() - t0).toBeLessThan(2_000);
        });
        it(`${name}: a missing secret is a config error and nothing is sent`, async () => {
            const { fetcher, calls } = mock(() => json({}));
            expect(await kindOf(make().complete(REQ, ctx(fetcher, {})))).toBe("config");
            expect(calls.length).toBe(0);
        });
        it(`${name}: a 2xx with the wrong shape is bad_response`, async () => {
            const { fetcher } = mock(() => json({ unexpected: true }));
            expect(await kindOf(make().complete(REQ, ctx(fetcher)))).toBe("bad_response");
        });
    }
});
describe("LLM adapters", () => {
    it("ollama-cloud posts to the chat API with the bearer key and reads message.content", async () => {
        const { fetcher, calls } = mock(() => json({ message: { content: "{\"say\":\"hi\"}" } }));
        const p = ollamaCloudLlm({ id: "o", kind: "ollama-cloud", model: "gpt-oss:20b", timeoutMs: 2000, price: flat, secret: "KEY" });
        expect(await p.complete(REQ, ctx(fetcher))).toBe("{\"say\":\"hi\"}");
        expect(calls[0].url).toBe(OLLAMA_URL);
        expect(calls[0].init.headers.authorization).toBe("Bearer sk-test-not-real");
        expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: "gpt-oss:20b", stream: false, format: "json" });
    });
    it("openrouter refuses a non-free model id when free_only is on, before any request", async () => {
        const { fetcher, calls } = mock(() => json({ choices: [{ message: { content: "x" } }] }));
        const p = openRouterLlm({ id: "r", kind: "openrouter", model: "vendor/big-model", timeoutMs: 2000, price: flat, secret: "KEY", freeOnly: true });
        expect(await kindOf(p.complete(REQ, ctx(fetcher)))).toBe("config");
        expect(calls.length).toBe(0);
        const ok = openRouterLlm({ id: "r", kind: "openrouter", model: "vendor/m:free", timeoutMs: 2000, price: flat, secret: "KEY", freeOnly: true });
        expect(await ok.complete(REQ, ctx(fetcher))).toBe("x");
        expect(calls[0].url).toBe(OPENROUTER_URL);
    });
    it("openai-compatible joins base_url and /chat/completions and omits auth without a secret", async () => {
        const { fetcher, calls } = mock(() => json({ choices: [{ message: { content: "ok" } }] }));
        const p = openAiCompatibleLlm({ id: "c", kind: "openai-compatible", model: "m", timeoutMs: 2000, price: flat, baseUrl: "https://llm.test/v1/", jsonMode: false });
        expect(await p.complete(REQ, ctx(fetcher, {}))).toBe("ok");
        expect(calls[0].url).toBe("https://llm.test/v1/chat/completions");
        expect(calls[0].init.headers.authorization).toBeUndefined();
        expect(JSON.parse(String(calls[0].init.body)).response_format).toBeUndefined();
    });
    it("workers-ai runs the model through the binding and reads response", async () => {
        const seen = [];
        const AI = { run: async (m, input) => (seen.push([m, input]), { response: "{\"say\":\"hi\"}" }) };
        const p = workersAiLlm({ id: "w", kind: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", timeoutMs: 2000, price: flat });
        expect(await p.complete(REQ, ctx(hang, { AI }))).toBe("{\"say\":\"hi\"}");
        expect(seen[0][0]).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
        expect(await kindOf(p.complete(REQ, ctx(hang, {})))).toBe("config"); // no binding
        const slow = { run: () => new Promise(() => { }) };
        expect(await kindOf(p.complete(REQ, ctx(hang, { AI: slow }, 200)))).toBe("timeout");
        const broken = { run: async () => { throw new Error("boom"); } };
        expect(await kindOf(p.complete(REQ, ctx(hang, { AI: broken })))).toBe("upstream");
    });
});
describe("Anthropic adapter (SDK with a mocked fetch)", () => {
    const make = (over = {}) => anthropicLlm({ id: "a", kind: "anthropic", model: "claude-opus-5-5", timeoutMs: 2000, price: { input_usd_per_mtok: 4, output_usd_per_mtok: 20 }, secret: "KEY", effort: "low", maxTokens: 2048, fallbacks: true, ...over });
    const message = (content, stop_reason = "end_turn", extra = {}) => json({ id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 }, ...extra });
    it("sends model, effort, max_tokens, the system frame and the server-side fallback, and joins the text blocks", async () => {
        const { fetcher, calls } = mock(() => message([{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "{\"say\":" }, { type: "text", text: "\"hi\"}" }]));
        expect(await make().complete(REQ, ctx(fetcher))).toBe("{\"say\":\"hi\"}");
        const c = calls[0];
        expect(c.url).toMatch(/\/v1\/messages(\?beta=true)?$/);
        const h = new Headers(c.init.headers);
        expect(h.get("authorization") ?? h.get("x-api-key")).toMatch(/sk-test-not-real$/); // SDK 1.x sends the key as a bearer token
        expect(h.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
        const body = JSON.parse(String(c.init.body));
        expect(body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 2048, system: "sys", output_config: { effort: "low" }, fallbacks: "default" });
        expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
        expect(body.thinking).toBeUndefined(); // thinking cannot be disabled on this model family
    });
    it("can switch the fallback off", async () => {
        const { fetcher, calls } = mock(() => message([{ type: "text", text: "x" }]));
        await make({ fallbacks: false }).complete(REQ, ctx(fetcher));
        expect(JSON.parse(String(calls[0].init.body)).fallbacks).toBeUndefined();
    });
    it("a refusal is a ProviderError, never a reply", async () => {
        const { fetcher } = mock(() => message([{ type: "text", text: "I can't help with that." }], "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: null } }));
        expect(await kindOf(make().complete(REQ, ctx(fetcher)))).toBe("refused");
    });
    it("no text at all (for example max_tokens spent thinking) is bad_response", async () => {
        const { fetcher } = mock(() => message([{ type: "thinking", thinking: "", signature: "s" }], "max_tokens"));
        expect(await kindOf(make().complete(REQ, ctx(fetcher)))).toBe("bad_response");
    });
    it("the estimate counts the larger max_tokens, because thinking spends it", () => {
        const p = make();
        expect(p.estimateMicros({ system: "x".repeat(300), user: "", maxOutputTokens: 300 })).toBe(Math.ceil(100 * 4 + 2048 * 20));
    });
});
describe("STT adapters", () => {
    const audio = wav16(1);
    const req = { audio, contentType: "audio/wav", maxSeconds: 30 };
    it("workers-ai sends base64 audio and reads text", async () => {
        let input;
        const AI = { run: async (_m, i) => ((input = i), { text: "hello there" }) };
        const p = workersAiStt({ id: "w", kind: "workers-ai", model: "@cf/openai/whisper-large-v3-turbo", timeoutMs: 2000, price: { usd_per_minute: 0.0005 } });
        expect(await p.transcribe(req, ctx(hang, { AI }))).toBe("hello there");
        expect(typeof input.audio).toBe("string");
        expect(atob(input.audio).length).toBe(audio.length);
        expect(p.estimateMicros(req)).toBe(250); // 30 s worst case at $0.0005 a minute
    });
    it("deepgram posts the raw audio with a Token header and reads the first alternative", async () => {
        const { fetcher, calls } = mock(() => json({ results: { channels: [{ alternatives: [{ transcript: "hi" }] }] } }));
        const p = deepgramStt({ id: "d", kind: "deepgram", model: "nova-3", timeoutMs: 2000, price: flat, secret: "KEY", language: "en" });
        expect(await p.transcribe(req, ctx(fetcher))).toBe("hi");
        expect(calls[0].url).toBe("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=en");
        expect(calls[0].init.headers.authorization).toBe("Token sk-test-not-real");
        expect(calls[0].init.headers["content-type"]).toBe("audio/wav");
        const { fetcher: f401 } = mock(() => json({}, 401));
        expect(await kindOf(p.transcribe(req, ctx(f401)))).toBe("auth");
    });
    it("openai-compatible posts multipart to /audio/transcriptions with the model", async () => {
        const { fetcher, calls } = mock(() => json({ text: "hi" }));
        const p = openAiCompatibleStt({ id: "o", kind: "openai-compatible", model: "whisper-1", timeoutMs: 2000, price: flat, baseUrl: "https://api.test/v1", secret: "KEY" });
        expect(await p.transcribe(req, ctx(fetcher))).toBe("hi");
        expect(calls[0].url).toBe("https://api.test/v1/audio/transcriptions");
        const form = calls[0].init.body;
        expect(form.get("model")).toBe("whisper-1");
        expect(form.get("file").size).toBe(audio.length);
    });
    it("whisper-http posts the configured field to the fixed URL", async () => {
        const { fetcher, calls } = mock(() => json({ text: "hi" }));
        const p = whisperHttpStt({ id: "h", kind: "whisper-http", model: "whisper", timeoutMs: 2000, price: flat, url: "https://whisper.test/inference", field: "audio_file" });
        expect(await p.transcribe(req, ctx(fetcher, {}))).toBe("hi");
        expect(calls[0].url).toBe("https://whisper.test/inference");
        expect(calls[0].init.body.get("audio_file")).not.toBeNull();
        const { fetcher: bad } = mock(() => json({ transcript: "wrong field" }));
        expect(await kindOf(p.transcribe(req, ctx(bad, {})))).toBe("bad_response");
        expect(await kindOf(p.transcribe(req, ctx(hang, {}, 200)))).toBe("timeout");
    });
});
describe("TTS adapters", () => {
    const req = { text: "Good evening. Mind the step.", voice: null };
    it("workers-ai asks for linear16 in a wav container and reads a stream", async () => {
        let input;
        const AI = { run: async (_m, i) => ((input = i), new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } })) };
        const p = workersAiTts({ id: "w", kind: "workers-ai", model: "@cf/deepgram/aura-2-en", timeoutMs: 2000, price: { usd_per_mchar: 30 }, format: "wav", defaultVoice: "luna" });
        const out = await p.synthesize(req, ctx(hang, { AI }));
        expect(Array.from(out.audio)).toEqual([1, 2, 3]);
        expect(out.contentType).toBe("audio/wav");
        expect(input).toMatchObject({ text: req.text, speaker: "luna", encoding: "linear16", container: "wav" });
        expect(p.estimateMicros(req)).toBe(req.text.length * 30);
    });
    it("elevenlabs puts the voice in the path, the key in xi-api-key, and wraps PCM as WAV", async () => {
        const pcm = new Uint8Array([0, 1, 2, 3]);
        const { fetcher, calls } = mock(() => new Response(pcm));
        const p = elevenLabsTts({ id: "e", kind: "elevenlabs", model: "eleven_flash_v2_5", timeoutMs: 2000, price: flat, format: "wav", defaultVoice: "voice123", secret: "KEY" });
        const out = await p.synthesize(req, ctx(fetcher));
        expect(calls[0].url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=pcm_22050");
        expect(calls[0].init.headers["xi-api-key"]).toBe("sk-test-not-real");
        expect(String.fromCharCode(...out.audio.slice(0, 4))).toBe("RIFF");
        expect(out.audio.length).toBe(44 + pcm.length);
        const noVoice = elevenLabsTts({ id: "e", kind: "elevenlabs", model: "m", timeoutMs: 2000, price: flat, format: "mp3", defaultVoice: null, secret: "KEY" });
        expect(await kindOf(noVoice.synthesize(req, ctx(fetcher)))).toBe("config");
    });
    it("azure escapes the text into SSML and refuses a malformed voice name", async () => {
        const { fetcher, calls } = mock(() => new Response(new Uint8Array([9])));
        const p = azureTts({ id: "a", kind: "azure", model: "neural", timeoutMs: 2000, price: flat, format: "mp3", defaultVoice: "en-US-AvaNeural", secret: "KEY", region: "westus2" });
        await p.synthesize({ text: "Tom & <Jerry>", voice: null }, ctx(fetcher));
        expect(calls[0].url).toBe("https://westus2.tts.speech.microsoft.com/cognitiveservices/v1");
        expect(String(calls[0].init.body)).toContain("Tom &amp; &lt;Jerry&gt;");
        expect(calls[0].init.headers["ocp-apim-subscription-key"]).toBe("sk-test-not-real");
        expect(await kindOf(p.synthesize({ text: "x", voice: "en-US-Ava\"/><x" }, ctx(fetcher)))).toBe("config");
        expect(xmlEscape("'\"")).toBe("&apos;&quot;");
    });
    it("http: piper and openai-speech shapes", async () => {
        const { fetcher, calls } = mock(() => new Response(new Uint8Array([7, 7])));
        const piper = httpTts({ id: "p", kind: "http", model: "self-hosted", timeoutMs: 2000, price: flat, format: "wav", defaultVoice: null, url: "https://tts.test/", shape: "piper" });
        await piper.synthesize(req, ctx(fetcher, {}));
        expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: req.text });
        const oai = httpTts({ id: "c", kind: "http", model: "chatterbox", timeoutMs: 2000, price: flat, format: "wav", defaultVoice: "default", url: "https://cb.test/v1/audio/speech", shape: "openai-speech" });
        await oai.synthesize(req, ctx(fetcher, {}));
        expect(JSON.parse(String(calls[1].init.body))).toEqual({ model: "chatterbox", input: req.text, voice: "default", response_format: "wav" });
        const { fetcher: empty } = mock(() => new Response(new Uint8Array([])));
        expect(await kindOf(piper.synthesize(req, ctx(empty, {})))).toBe("bad_response");
        const { fetcher: down } = mock(() => new Response("x", { status: 502 }));
        expect(await kindOf(oai.synthesize(req, ctx(down, {})))).toBe("upstream");
    });
});
describe("cost arithmetic", () => {
    it("per-million prices in dollars are per-unit prices in micro-dollars", () => {
        expect(costMicros({ flat: true }, { inTokens: 1e6, outTokens: 1e6 })).toBe(0);
        expect(costMicros({ input_usd_per_mtok: 3, output_usd_per_mtok: 15 }, { inTokens: 1000, outTokens: 100 })).toBe(4500);
        expect(costMicros({ usd_per_minute: 0.006 }, { minutes: 0.5 })).toBe(3000);
        expect(costMicros({ usd_per_mchar: 30 }, { chars: 100 })).toBe(3000);
    });
    it("WAV helpers agree with each other", () => {
        expect(wavSeconds(wavFromPcm16(new Uint8Array(44_100), 22_050))).toBeCloseTo(1, 5);
    });
});
function wav16(seconds) {
    return wavFromPcm16(new Uint8Array(Math.round(seconds * 22_050) * 2), 22_050);
}
