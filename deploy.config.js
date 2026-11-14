// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// What tools/deploy.mjs uploads. wrangler.jsonc says the same for people who use Wrangler; a test
// keeps the two in agreement. No account id, token or secret value belongs here: those come from
// the environment (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN) and from `deploy.mjs secret`.

export default {
    name: "nhe-relay",
    main: "src/index.js",
    compatibility_date: "2026-10-01",
    workers_dev: true,
    observability: true,
    // Workers AI binding: used by every provider of kind "workers-ai". Set to null if you use none.
    ai_binding: "AI",
    durable_objects: [{ name: "LIMITER", class_name: "Limiter" }],
    migration: { tag: "v1", new_sqlite_classes: ["Limiter"] },
    vars: {
        // Kill switch. Anything but exactly "yes" refuses every call. A plain deploy ships "no";
        // `node tools/deploy.mjs --live` turns it on.
        RELAY_ENABLED: "no",
        // Narrowing only: values above the constants in src/limits.js are refused.
        GLOBAL_DAILY_CEILING: "500",
    },
};
