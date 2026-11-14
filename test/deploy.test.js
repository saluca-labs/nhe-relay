// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// tools/deploy.mjs against a hand-written mock of the Cloudflare API. Nothing here reaches the
// network or needs credentials.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "./expect.js";
import { collectModules, buildMetadata, buildForm, deploy, putSecret } from "../tools/deploy.mjs";
import cfg from "../deploy.config.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-test-token-not-real";
const ENV = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN };

function cloudflare(scripts = []) {
    const calls = [];
    const fetcher = async (url, init) => {
        calls.push({ url, init });
        const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], result }), { headers: { "content-type": "application/json" } });
        if (init.method === "GET") return ok(scripts);
        return ok({});
    };
    return { fetcher, calls };
}

describe("deploy without Wrangler", () => {
    it("uploads exactly the modules reachable from the entry, data modules included, tests excluded", () => {
        const mods = [...collectModules(cfg.main).keys()];
        expect(mods[0]).toBe("src/index.js");
        for (const m of ["relay.config.js", "personas/registry.js", "knowledge/lore.js", "src/limiter.js", "src/providers/llm/anthropic.js", "src/extensions/mcp.js"]) expect(mods, m).toContain(m);
        expect(mods.some((m) => m.startsWith("test/") || m.startsWith("tools/") || m.startsWith("examples/"))).toBe(false);
        for (const [, text] of collectModules(cfg.main)) expect(text).not.toContain("cloudflare:workers");
    });
    it("builds bindings for AI, the limiter Durable Object and the vars, and keeps secrets", () => {
        const m = buildMetadata(cfg);
        expect(m.main_module).toBe("src/index.js");
        expect(m.keep_bindings).toEqual(["secret_text"]);
        expect(m.bindings).toEqual([
            { type: "ai", name: "AI" },
            { type: "durable_object_namespace", name: "LIMITER", class_name: "Limiter" },
            { type: "plain_text", name: "RELAY_ENABLED", text: "no" },
            { type: "plain_text", name: "GLOBAL_DAILY_CEILING", text: "500" },
        ]);
        expect(m.migrations).toEqual({ new_tag: "v1", new_sqlite_classes: ["Limiter"] });
        expect(buildMetadata(cfg, { live: true }).bindings.find((b) => b.name === "RELAY_ENABLED").text).toBe("yes");
        expect(buildMetadata(cfg, { includeMigration: false }).migrations).toBeUndefined();
    });
    it("sends one multipart upload with the metadata and every module as an ES module", async () => {
        const form = buildForm(buildMetadata(cfg), collectModules(cfg.main));
        expect(JSON.parse(await form.get("metadata").text()).main_module).toBe("src/index.js");
        const entry = form.get("src/index.js");
        expect(entry.type).toBe("application/javascript+module");
        expect(entry.name).toBe("src/index.js");
    });
    it("deploys: list scripts, upload, enable workers.dev, with the token only in the auth header", async () => {
        const { fetcher, calls } = cloudflare([]);
        const logs = [];
        const s = await deploy({ cfg, env: ENV, fetcher, log: (l) => logs.push(l) });
        expect(calls.map((c) => `${c.init.method} ${c.url.replace(ACCOUNT, "A")}`)).toEqual([
            "GET https://api.cloudflare.com/client/v4/accounts/A/workers/scripts",
            "PUT https://api.cloudflare.com/client/v4/accounts/A/workers/scripts/nhe-relay",
            "POST https://api.cloudflare.com/client/v4/accounts/A/workers/scripts/nhe-relay/subdomain",
        ]);
        for (const c of calls) expect(c.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(JSON.parse(await calls[1].init.body.get("metadata").text()).migrations).toEqual({ new_tag: "v1", new_sqlite_classes: ["Limiter"] });
        expect(s).toMatchObject({ script: "nhe-relay", migration: "v1", relay_enabled: "no" });
        expect(logs.join("\n")).not.toContain(TOKEN);
    });
    it("skips the migration once the deployed script has recorded it", async () => {
        const { fetcher, calls } = cloudflare([{ id: "nhe-relay", migration_tag: "v1" }]);
        await deploy({ cfg, env: ENV, fetcher, log: () => {} });
        expect(JSON.parse(await calls[1].init.body.get("metadata").text()).migrations).toBeUndefined();
    });
    it("refuses without credentials, before any request, and hides the account id in errors", async () => {
        const { fetcher, calls } = cloudflare([]);
        await expect(deploy({ cfg, env: {}, fetcher, log: () => {} })).rejects.toThrow();
        await expect(deploy({ cfg, env: { CLOUDFLARE_ACCOUNT_ID: "nope", CLOUDFLARE_API_TOKEN: TOKEN }, fetcher, log: () => {} })).rejects.toThrow();
        expect(calls.length).toBe(0);
        const failing = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
        let msg = "";
        try {
            await deploy({ cfg, env: ENV, fetcher: failing, log: () => {} });
        } catch (e) {
            msg = e.message;
        }
        expect(msg).toContain("HTTP 403");
        expect(msg).not.toContain(ACCOUNT);
        expect(msg).not.toContain(TOKEN);
    });
    it("sets a secret without ever printing its value", async () => {
        const { fetcher, calls } = cloudflare();
        const logs = [];
        await putSecret({ cfg, name: "RELAY_HMAC_KEY", value: "super-secret-test-value-0123456789", env: ENV, fetcher, log: (l) => logs.push(l) });
        expect(calls[0].url).toContain("/workers/scripts/nhe-relay/secrets");
        expect(JSON.parse(calls[0].init.body)).toEqual({ name: "RELAY_HMAC_KEY", text: "super-secret-test-value-0123456789", type: "secret_text" });
        expect(logs.join("\n")).not.toContain("super-secret-test-value");
        await expect(putSecret({ cfg, name: "bad name", value: "x", env: ENV, fetcher, log: () => {} })).rejects.toThrow();
    });
    it("wrangler.jsonc says the same thing as deploy.config.js", () => {
        const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
        const w = JSON.parse(text);
        expect(w.name).toBe(cfg.name);
        expect(w.main).toBe(cfg.main);
        expect(w.compatibility_date).toBe(cfg.compatibility_date);
        expect(w.vars).toEqual(cfg.vars);
        expect(w.ai.binding).toBe(cfg.ai_binding);
        expect(w.durable_objects.bindings).toEqual(cfg.durable_objects);
        expect(w.migrations).toEqual([{ tag: cfg.migration.tag, new_sqlite_classes: cfg.migration.new_sqlite_classes }]);
    });
});
