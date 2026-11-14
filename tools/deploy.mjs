// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Deploy without Wrangler, with nothing to install: uploads the Worker's ES modules and its
// bindings straight to the Cloudflare Workers Scripts API.
//
//   node tools/deploy.mjs --dry-run      print what would be uploaded; no network, no credentials
//   node tools/deploy.mjs                deploy with the kill switch off-state from deploy.config.js
//   node tools/deploy.mjs --live         the same with RELAY_ENABLED=yes
//   node tools/deploy.mjs secret NAME    set a Worker secret; the value is read from stdin
//
// Credentials come from the environment at call time and are never written anywhere:
//   CLOUDFLARE_ACCOUNT_ID   your account id
//   CLOUDFLARE_API_TOKEN    a token scoped to "Workers Scripts: Edit" (plus "Workers AI: Read"
//                           when you use the AI binding)
// Nothing here prints a token or a secret value.

import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.cloudflare.com/client/v4";

/** Every module reachable from the entry, by following relative imports. Paths are repo-relative. */
export function collectModules(entry, root = ROOT) {
    const seen = new Map();
    const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/g;
    const visit = (rel) => {
        if (seen.has(rel)) return;
        const text = readFileSync(join(root, rel), "utf8");
        seen.set(rel, text);
        for (const m of text.matchAll(IMPORT)) {
            const next = normalize(join(dirname(rel), m[1])).split("\\").join("/");
            if (next.startsWith("..")) throw new Error(`import leaves the repository: ${m[1]} in ${rel}`);
            visit(next);
        }
    };
    visit(entry);
    return seen;
}

/** The upload metadata: entry module, bindings, observability, and the DO migration if needed. */
export function buildMetadata(cfg, { live = false, includeMigration = true } = {}) {
    const bindings = [];
    if (cfg.ai_binding) bindings.push({ type: "ai", name: cfg.ai_binding });
    for (const d of cfg.durable_objects) bindings.push({ type: "durable_object_namespace", name: d.name, class_name: d.class_name });
    const vars = { ...cfg.vars, ...(live ? { RELAY_ENABLED: "yes" } : {}) };
    for (const [name, text] of Object.entries(vars)) bindings.push({ type: "plain_text", name, text: String(text) });
    return {
        main_module: cfg.main,
        compatibility_date: cfg.compatibility_date,
        bindings,
        // Secrets are set separately (deploy.mjs secret) and must survive every upload.
        keep_bindings: ["secret_text"],
        observability: { enabled: Boolean(cfg.observability) },
        ...(includeMigration && cfg.migration ? { migrations: { new_tag: cfg.migration.tag, new_sqlite_classes: cfg.migration.new_sqlite_classes } } : {}),
    };
}

export function buildForm(metadata, modules) {
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    for (const [path, text] of modules) {
        form.append(path, new Blob([text], { type: "application/javascript+module" }), path);
    }
    return form;
}

function credentials(env) {
    const account = env.CLOUDFLARE_ACCOUNT_ID;
    const token = env.CLOUDFLARE_API_TOKEN;
    if (!account || !/^[0-9a-f]{32}$/.test(account)) throw new Error("CLOUDFLARE_ACCOUNT_ID is missing or not a 32-character hex id");
    if (!token) throw new Error("CLOUDFLARE_API_TOKEN is missing");
    return { account, token };
}

async function api(fetcher, token, method, path, body, contentType) {
    const headers = { authorization: `Bearer ${token}` };
    if (contentType) headers["content-type"] = contentType;
    const r = await fetcher(`${API}${path}`, { method, headers, body });
    let j = null;
    try {
        j = await r.json();
    } catch {
        // fall through: an unreadable reply is a failure
    }
    if (!r.ok || !j || j.success !== true) {
        const errs = (j?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
        throw new Error(`${method} ${path.replace(/accounts\/[0-9a-f]+/, "accounts/<account>")} failed: HTTP ${r.status}${errs ? ` (${errs})` : ""}`);
    }
    return j.result;
}

/** Upload and (when workers_dev) enable the workers.dev route. Returns a short summary. */
export async function deploy({ cfg, env = process.env, fetcher = fetch, live = false, log = console.log } = {}) {
    const { account, token } = credentials(env);
    const modules = collectModules(cfg.main);
    // Apply the Durable Object migration only when the deployed script has not recorded it yet.
    const scripts = await api(fetcher, token, "GET", `/accounts/${account}/workers/scripts`);
    const current = Array.isArray(scripts) ? scripts.find((s) => s.id === cfg.name) : undefined;
    const includeMigration = !current || current.migration_tag !== cfg.migration?.tag;
    const metadata = buildMetadata(cfg, { live, includeMigration });
    await api(fetcher, token, "PUT", `/accounts/${account}/workers/scripts/${cfg.name}`, buildForm(metadata, modules));
    if (cfg.workers_dev) {
        await api(fetcher, token, "POST", `/accounts/${account}/workers/scripts/${cfg.name}/subdomain`, JSON.stringify({ enabled: true }), "application/json");
    }
    const summary = { script: cfg.name, modules: modules.size, migration: includeMigration ? cfg.migration?.tag ?? null : "already applied", relay_enabled: metadata.bindings.find((b) => b.name === "RELAY_ENABLED")?.text };
    log(JSON.stringify(summary));
    return summary;
}

/** Set one Worker secret. The value is passed in, never printed. */
export async function putSecret({ cfg, name, value, env = process.env, fetcher = fetch, log = console.log }) {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(name)) throw new Error("secret name must look like RELAY_HMAC_KEY");
    if (!value) throw new Error("empty secret value");
    const { account, token } = credentials(env);
    await api(fetcher, token, "PUT", `/accounts/${account}/workers/scripts/${cfg.name}/secrets`, JSON.stringify({ name, text: value, type: "secret_text" }), "application/json");
    log(`secret ${name} set on ${cfg.name}`);
}

async function readStdin() {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function main(argv) {
    const cfg = (await import(pathToFileURL(join(ROOT, "deploy.config.js")).href)).default;
    if (argv[0] === "secret") {
        if (process.stdin.isTTY) console.error(`paste the value for ${argv[1]}, then press Enter and Ctrl-D (Ctrl-Z on Windows):`);
        await putSecret({ cfg, name: argv[1], value: await readStdin() });
        return;
    }
    const live = argv.includes("--live");
    if (argv.includes("--dry-run")) {
        const modules = collectModules(cfg.main);
        const metadata = buildMetadata(cfg, { live });
        console.log(JSON.stringify({ metadata, modules: [...modules.keys()], bytes: [...modules.values()].reduce((n, t) => n + Buffer.byteLength(t), 0) }, null, 2));
        return;
    }
    await deploy({ cfg, live });
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === "") {
    main(process.argv.slice(2)).catch((e) => {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
    });
}
