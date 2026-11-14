# Deploy

nhe-relay deploys with `tools/deploy.mjs`, a single file with no dependencies that talks to the
Cloudflare API with Node's built-in `fetch`. Wrangler also works, if you prefer it (below).

> **Status:** `tools/deploy.mjs` is unit-tested against a mocked Cloudflare API (the requests, the
> multipart body, the migration handling, error handling and that no credential is printed). It
> has **not yet been run against a real Cloudflare account from this repository**.

## What you need

- Node 20 or later. Nothing to install.
- A Cloudflare account with Workers and Workers AI.
- An API token for that account, created in the Cloudflare dashboard, with:
  - Account, Workers Scripts: Edit
  - Account, Workers AI: Read (only if you use the `AI` binding)
- Your account id (on the Workers overview page of the dashboard).

Both are read from the environment at call time and never written to a file:

```bash
export CLOUDFLARE_ACCOUNT_ID=<your account id>
export CLOUDFLARE_API_TOKEN=<your token>
```

## Commands

| Command | What it does |
|---|---|
| `node tools/deploy.mjs --dry-run` | Prints the upload metadata and the module list. No network, no credentials. |
| `node tools/deploy.mjs` | Uploads the Worker with the vars in `deploy.config.js` (kill switch off: `RELAY_ENABLED` is `"no"`). |
| `node tools/deploy.mjs --live` | The same with `RELAY_ENABLED` set to `"yes"`. |
| `node tools/deploy.mjs secret NAME` | Sets the Worker secret `NAME` from stdin. The value is never printed. |

A first deploy, then the one secret the relay needs:

```bash
node tools/deploy.mjs
openssl rand -hex 32 | node tools/deploy.mjs secret RELAY_HMAC_KEY
```

Add each provider secret your `relay.config.js` names the same way, for example
`node tools/deploy.mjs secret ANTHROPIC_API_KEY` and paste the key. Check `GET /health`; when you
are ready for traffic, run `node tools/deploy.mjs --live`.

## What the upload contains

- **Modules:** `src/index.js` and every module it imports, followed through relative imports:
  the rest of `src/`, `relay.config.js`, `personas/registry.js` and `knowledge/lore.js`. Tests,
  tools and examples are never uploaded. Each goes up as `application/javascript+module`, exactly
  as it is in the repository.
- **Metadata** (from `deploy.config.js`): the entry module, the compatibility date, the bindings
  (`ai` for Workers AI, `durable_object_namespace` for the `Limiter`, and `plain_text` for the
  vars), `keep_bindings: ["secret_text"]` so every secret survives the upload, observability on,
  and the Durable Object migration (`new_sqlite_classes: ["Limiter"]`, tag `v1`) only while the
  deployed script has not recorded that tag yet.
- **Requests:** `GET .../workers/scripts` (to read the migration tag), `PUT
  .../workers/scripts/nhe-relay` (the multipart upload), and `POST .../subdomain` to enable the
  `workers.dev` route. Secrets go to `PUT .../workers/scripts/nhe-relay/secrets`.

Errors name the request and Cloudflare's error code; they never include the token, and the
account id is masked.

## With Wrangler instead

`wrangler.jsonc` describes the same Worker (a test keeps it in agreement with
`deploy.config.js`). Wrangler is not a dependency of this repository; use your own install:

```bash
wrangler deploy
wrangler secret put RELAY_HMAC_KEY
wrangler deploy --var RELAY_ENABLED:yes
```

## Turning it off

Any of these refuses every call within seconds of the new version reaching Cloudflare:

- `node tools/deploy.mjs` (a plain deploy sets `RELAY_ENABLED` back to `"no"`);
- lowering the spend ceiling: `SPEND_DAILY_USD` may only narrow `spend.daily_usd_ceiling`;
- deleting the `RELAY_HMAC_KEY` secret (a missing key is a refusal).
