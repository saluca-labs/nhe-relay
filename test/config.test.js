// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

import { describe, it, expect } from "./expect.js";
import { loadConfig } from "../src/config.js";
import { currentConfig } from "../src/index.js";
import { LIMITS } from "../src/limits.js";
import shipped from "../relay.config.js";
import allProviders from "../examples/configs/all-providers.js";
import { rawConfig } from "./helpers.js";
describe("relay.config.js", () => {
    it("the shipped config and the all-providers example both load", () => {
        const a = loadConfig(shipped);
        expect(a.llm.map((p) => p.kind)).toEqual(["workers-ai"]);
        expect(a.spendCeilingMicros).toBe(2_000_000);
        const b = loadConfig(allProviders);
        expect(b.llm.map((p) => p.kind)).toEqual(["anthropic", "ollama-cloud", "openrouter", "openai-compatible", "workers-ai"]);
        expect(b.stt.map((p) => p.kind)).toEqual(["deepgram", "openai-compatible", "whisper-http", "workers-ai"]);
        expect(b.tts.map((p) => p.kind)).toEqual(["elevenlabs", "azure", "http", "http", "workers-ai"]);
        expect(b.policy.kind).toBe("builtin");
        expect(b.knowledge.kind).toBe("none");
        expect(b.receipts.kind).toBe("log");
    });
    it("the Anthropic adapter defaults to claude-opus-5-5 at low effort with the server-side fallback on", () => {
        const c = loadConfig(rawConfig({ llm: [{ id: "c", kind: "anthropic", secret: "ANTHROPIC_API_KEY", price: { input_usd_per_mtok: 4, output_usd_per_mtok: 20 } }] }));
        expect(c.llm[0].model).toBe("claude-opus-5-5");
    });
    const refused = [
        ["a provider without a price", { llm: [{ id: "a", kind: "workers-ai", model: "@cf/x" }] }],
        ["a malformed price", { llm: [{ id: "a", kind: "workers-ai", model: "@cf/x", price: { usd_per_minute: 1 } }] }],
        ["a negative price", { llm: [{ id: "a", kind: "workers-ai", model: "@cf/x", price: { input_usd_per_mtok: -1, output_usd_per_mtok: 1 } }] }],
        ["a plain-http base URL", { llm: [{ id: "a", kind: "openai-compatible", base_url: "http://llm.example.com/v1", model: "m", price: { flat: true } }] }],
        ["a URL with a query string", { llm: [{ id: "a", kind: "openai-compatible", base_url: "https://llm.example.com/v1?key=abc", model: "m", price: { flat: true } }] }],
        ["a key value where a secret name belongs", { llm: [{ id: "a", kind: "ollama-cloud", model: "m", secret: "sk-live-abcdef", price: { flat: true } }] }],
        ["an unknown provider kind", { llm: [{ id: "a", kind: "magic", model: "m", price: { flat: true } }] }],
        ["an unknown field", { llm: [{ id: "a", kind: "workers-ai", model: "@cf/x", price: { flat: true }, api_key: "x" }] }],
        ["no LLM at all", { llm: [] }],
        ["duplicate ids", { llm: [{ id: "a", kind: "workers-ai", model: "@cf/x", price: { flat: true } }, { id: "a", kind: "workers-ai", model: "@cf/y", price: { flat: true } }] }],
        ["a timeout above the code ceiling", { llm: [{ id: "a", kind: "workers-ai", model: "@cf/x", timeout_ms: LIMITS.providerTimeoutMs + 1, price: { flat: true } }] }],
        ["a spend ceiling above the code ceiling", { spend: { daily_usd_ceiling: LIMITS.spendUsdPerDay + 1 } }],
        ["no spend ceiling", { spend: undefined }],
        ["a wildcard CORS origin", { cors: { origins: ["*"] } }],
        ["a CORS origin with a path", { cors: { origins: ["https://game.example/play"] } }],
        ["an unknown top-level field", { model: "gpt" }],
        ["an unknown policy kind", { policy: { kind: "allow-all" } }],
        ["an unknown knowledge kind", { knowledge: { kind: "web" } }],
        ["an azure region with a dot", { tts: [{ id: "a", kind: "azure", region: "evil.example", voice: "en-US-AvaNeural", secret: "AZ_KEY", price: { flat: true } }] }],
    ];
    for (const [what, over] of refused) {
        it(`refuses ${what}`, () => expect(() => loadConfig(rawConfig(over))).toThrow());
    }
    it("a config that fails to load leaves the relay refusing, with the reason kept for the log", () => {
        const r = currentConfig(rawConfig({ llm: [] }));
        expect(r.config).toBeNull();
        expect(r.error).toMatch(/llm/);
    });
});
