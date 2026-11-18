# Spike Report T1.00: Self-hosted nhe-relay for per-employee agents

**Task T1.00 (M1, W3) | The Atom | 2026-11-18**

## Scope

Port saluca-labs/nhe-relay from a Cloudflare Worker to a self-hosted Node process, so a
customer can run their own relay instance on their infrastructure. Validate three things on the
ported server: multi-employee isolation, live TKHR KB grounding over MCP with per-agent grants,
and receipts into the audit chain. Scope the tool-call extension the product will need.

## What was built

### 1. Node server entry point (`host/server.js`)

The Worker entry (`src/index.js`) exports `default { async fetch(request, env) }`. The Node
server wraps that handler for a self-hosted process:

- `http.createServer` maps `IncomingMessage` to a Web `Request`, calls the Worker's `fetch`,
  and writes the `Response` back. Node 20+ has global `Request`, `Response`, `Headers`,
  `fetch` and `crypto.subtle`, so no polyfills are needed.
- `buildEnv(processEnv)` maps `process.env` strings into the `env` object the relay expects.
  Worker bindings (`LIMITER`, `AI`) are replaced by local equivalents.
- `makeLimiterBinding(limiter)` mimics the Durable Object binding interface
  (`env.LIMITER.get(env.LIMITER.idFromName("global")).fetch(...)`) with an in-process limiter.
- IP extraction: `cf-connecting-ip` is absent on a direct Node server, so the server falls
  back to `x-forwarded-for` (first hop) or `req.socket.remoteAddress`.
- `node host/server.js` starts the server. `PORT` and `HOST` env vars or `--port`/`--host`
  flags configure the listen address. Default: `127.0.0.1:8787`.

The zero-dependency principle is preserved: the server uses only Node built-ins
(`node:http`) and the existing source tree. No npm packages, no bundler, no build step.

### 2. In-process limiter (`src/local-limiter.js`)

The Durable Object (`src/limiter.js`) provides strongly consistent counters backed by the
Workers runtime. On Node, a single-process `Map` is equally consistent. The core logic
(`src/limiter-core.js`) is already runtime-agnostic: it takes any `CounterStore` with
`get(key)` and `put(entries)`. `LocalLimiter` provides one, plus the same pruning logic
(windows older than two days, at most once an hour), behind the same `fetch` interface.

Multi-process deployments (multiple Node workers behind a load balancer) need an external
store (Redis, SQLite). This is documented as a known limitation, not built: a single-process
server covers the reference install and small customers.

### 3. Tests

Three new test files, 18 new tests, all shown RED on a planted fault then GREEN:

| File | Tests | Planted fault (RED) |
|---|---|---|
| `test/server.test.js` | 7 | `LocalLimiter.put` collapsed all keys to one shared key: the "isolates windows by key" test failed because two different rate-limit keys shared a counter. |
| `test/isolation.test.js` | 7 | (1) `checkReceipt` dropped `session_id` from the receipt message: the "state root does not chain into another session" test failed because A's receipt was valid for B's session. (2) `mcpRetriever` hardcoded one persona's `personaArgs` for all personas: the "persona B gets a different mindset" test failed because B got A's mindset. |
| `test/audit-chain.test.js` | 4 | `relay.js` set `prev_root` to the new `state_root` instead of the previous root: the "consecutive receipts form a hash-linked chain" test failed because the chain link pointed to the wrong root. |

Full suite: 203 tests, 0 failures (185 original + 18 new).

### 4. Live run on the reference host

```
HEALTH: {"ok":true,"service":"nhe-relay","version":"0.1.0","enabled":true,"config":"ok"}
GENESIS: 669f20cb9f69bb1e...
TURN (kill switch off): {"fallback":true,"reason":"kill_switch"}
LIVE RUN COMPLETE
```

The server starts, serves `/health` and `/v1/genesis` over real HTTP on localhost, and
enforces the kill switch. No Cloudflare account, no Worker binding, no external service.

## Validation results

### Multi-employee isolation

Three isolation layers, all tested:

1. **Chain isolation**: Employee A's receipt is bound to (persona_id, session_id, state_root,
   turn_count, memory_sha256). Employee B cannot use A's receipt to advance their own turn,
   because the session_id (and state_root) in the receipt message do not match B's. Tested
   with two employees running independent chains simultaneously: A and B each complete two
   turns, their state roots diverge, and cross-session receipt use is rejected with
   `chain_receipt`.

2. **Limiter isolation**: Rate-limit keys are hashed per session and per IP. Employee A
   exhausting their session-per-day limit does not block employee B, because the limiter keys
   are different. Tested with a shared limiter store and `SESSION_PER_DAY=1`: A's second turn
   is rate-limited, B's first turn still passes.

3. **Persona isolation**: Personas are resolved server-side from the registry. A request can
   name a persona by id but can never send, extend or override one. The relay rejects unknown
   fields, unknown persona ids, and personas that fail the injection screen.

### TKHR KB grounding over MCP with per-agent grants

The MCP knowledge provider (`src/extensions/mcp.js`) already supports per-persona arguments
through `personaArgs` in the config. This is the per-agent grant mechanism: each persona
(agent) can be mapped to a different `mindset` (TKHR KB), so persona A retrieves from
"sales-kb" and persona B from "eng-kb" over the same MCP server.

Tested with a mock MCP server that records the `tools/call` arguments:
- Persona "emp-a-agent" with `personaArgs: { "emp-a-agent": { mindset: "sales-kb" } }`
  retrieves from `mindset: "sales-kb"`.
- Persona "emp-b-agent" with `personaArgs: { "emp-b-agent": { mindset: "eng-kb" } }`
  retrieves from `mindset: "eng-kb"`.
- A persona with no explicit grant falls back to `fixedArgs` only (no mindset).
- Revoking a grant (changing the mapping) changes which mindset the persona gets.

The grant is per-persona, not global: changing one persona's mapping does not affect another's.

For a live TKHR KB, the customer points the MCP `url` at their own Asphodel mindset server
(or any MCP server that exposes a `recall` or `ask` tool). The relay carries the persona's
granted mindset as a `tools/call` argument, so the MCP server enforces the scope. The relay
also sanitises and caps retrieved passages (400 chars), drops any that carry an injection
shape or URL, and drops any that would reveal a `must_not_reveal` entry.

### Receipts into the audit chain

The receipt sink (`src/extensions/http-sink.js`) POSTs each turn receipt as JSON to a fixed
HTTPS URL. The receipt carries: `kind`, `persona_id`, `session_hash` (HMAC of the session id,
never the raw id), `turn_index`, `prev_root`, `state_root`, `receipt` (HMAC), `provider`,
`model`, `ms`. It never carries player text, reply text, or the raw session id.

Tested with a collector sink that captures every receipt:
- Consecutive receipts from the same session form a hash-linked chain:
  `receipt[N+1].prev_root == receipt[N].state_root`.
- A gap (dropping a receipt) breaks the chain: `prev_root` does not match.
- Receipts from different sessions do not chain into each other (different `session_hash`,
  no `prev_root` link).
- The `state_root` in each receipt matches the `state_root` returned to the client.

An audit chain consumer (a provenance ledger) receives these receipts and can verify the
chain without reading any content: each receipt carries the hash root and the HMAC, so the
chain is verifiable without the player's words or the model's reply.

## Tool-call extension scope

The relay today has no tool use: a turn is one bounded answer, no model-initiated actions.
The per-employee agent product needs agents that can act, not just converse. This section
scopes what adding tool calls would require, without building it.

### What "tool call" means here

A model response includes a `tool_calls` array (OpenAI shape) or `tool_use` content blocks
(Anthropic shape). Each names a tool and its arguments. The relay would need to:

1. **Define the tool surface per persona.** A persona's registry entry would list the tools
   it may call, with JSON Schema for each tool's arguments. This is the grant: persona A
   may call `search_crm`, persona B may not. The config already has `persona_args` for
   knowledge; tool grants would follow the same pattern.

2. **Validate tool calls before execution.** The model's tool call is untrusted output, like
   the reply text today. The relay would: parse the tool name and arguments, check the tool
   is in the persona's granted surface, validate arguments against the schema, and screen
   the arguments for injection (the same `screenInjection` and `containsUrl` checks). A tool
   call that fails any check is dropped (fallback), same as an unsafe reply.

3. **Execute through Tiresias.** In the product architecture, every tool call goes through
   Tiresias-ZT, the policy enforcement point. The relay would forward the validated tool call
   to Tiresias, which decides per-intent: autonomous (execute), supervised (queue for human
   approval), or denied. The relay's existing `tiresias` policy adapter is a stub that denies
   every call; a real adapter would call Tiresias's decision endpoint (which does not exist
   yet, per ARCHITECTURE.md). The tool-call extension therefore depends on Tiresias exposing
   a pre-call decision API, which is a separate workstream (W4).

4. **Return tool results to the model and continue the turn.** A tool call is a
   request-response within a turn: the model calls a tool, the relay executes it (through
   Tiresias), feeds the result back, and the model produces the final reply. This adds a
   second model call per turn (or more, if the model chains tool calls). The spend ceiling
   and time budget already handle multiple provider calls per turn; the turn budget
   (`turn_budget_ms`, ceiling 20s) may need to widen for tool-using agents.

5. **Receipt the tool call.** Each tool call and its result would be committed into the turn
   record (the `chain.turn` object), so the hash chain proves what was called and what was
   returned, without storing the content. The receipt sink would carry a `tool_calls`
   summary (tool name, outcome, ms) alongside the existing fields.

6. **Extend the output check.** The current output check validates `reply.say` (length, no
   URLs, no frame echo, no `must_not_reveal`). Tool calls need their own output check:
   arguments must not contain URLs (unless the tool is a search tool), must not reveal
   `must_not_reveal` entries, and must not echo the frame. The `checkOutput` and `reveals`
   functions are reusable.

### What does NOT change

- The persona model: personas stay server-side, resolved by id.
- The chain: tool calls are committed to the turn record, so the hash chain extends
  naturally.
- The kill switch, limits, and spend ceiling: these run before any provider call and are
  unaffected.
- The receipt sink: it already receives a structured receipt; adding tool-call fields is
  additive.

### Estimated effort

2-3 engineer-weeks for a first version that handles single-turn tool calls (model calls one
tool, relay executes it through Tiresias, model produces final reply). Multi-turn tool
chaining (model calls multiple tools in sequence) is a further 1-2 weeks. The hard dependency
is Tiresias's decision API (W4), not the relay.

## Limitations and open items

1. **Single-process limiter.** `LocalLimiter` is in-process. Multi-process deployments
   (PM2 cluster mode, Kubernetes pods) need an external counter store. SQLite or Redis would
   work; the `CounterStore` interface in `limiter-core.js` is the integration point.

2. **Workers AI binding.** The `env.AI` binding is not available on Node. Self-hosted
   deployments use other providers (OpenAI-compatible, Anthropic, OpenRouter, Ollama Cloud).
   The default `relay.config.js` uses Workers AI; a self-hosted config would use
   `openai-compatible` or `ollama-cloud` instead. The `examples/configs/all-providers.js`
   file shows every kind.

3. **TLS termination.** The Node server listens on plain HTTP. A self-hosted deployment
   behind a reverse proxy (nginx, Caddy) or in a private network does not need TLS on the
   relay itself. If direct TLS is needed, `node:http` can be swapped for `node:https` with
   cert and key paths from env. Not built: the reference install uses a reverse proxy.

4. **Tool-call extension.** Scoped above, not built. Depends on Tiresias W4.

5. **alfredZer0 comparison.** The plan (PLAN.md) frames T1.00 as "the customer's own
   nhe-relay vs alfredZer0." This spike ports nhe-relay to Node and validates the three
   product requirements (isolation, MCP grants, audit chain). alfredZer0 is a single-user
   desktop runtime (Nod fork); it does not provide multi-employee isolation, server-side
   personas, or an audit chain. nhe-relay, ported to Node, is the self-hosted relay for the
   per-employee agent product. alfredZer0 remains the personal-use runtime.

## Files changed

- `src/local-limiter.js` (new): in-process limiter for Node deployments
- `host/server.js` (new): Node HTTP server entry point
- `test/server.test.js` (new): 7 tests for the Node server
- `test/isolation.test.js` (new): 7 tests for multi-employee isolation
- `test/audit-chain.test.js` (new): 4 tests for receipt audit chain
- `docs/spike-t1.00.md` (new): this report

## How to re-check

```bash
node --test                                    # 203 tests, 0 failures
node host/server.js                             # starts on 127.0.0.1:8787
curl http://127.0.0.1:8787/health              # {"ok":true,"service":"nhe-relay",...}
```
