# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's private vulnerability reporting on this
repository (Security tab, "Report a vulnerability"). Do not open a public issue for a
vulnerability. Include the version or commit, what an attacker can do, and how to reproduce it.

## What the relay assumes

- **The player is adversarial.** Anything typed or spoken is data that may try to steer the
  model, extract the frame, spend money or spoil the story.
- **The client is untrusted.** A game build can be modified. Everything it sends back (memory,
  state root, receipt, scene, transcript lines) is validated, bounded and screened.
- **Providers can fail or misbehave.** Any provider can be slow, down, wrong in shape or
  over-chatty. Retrieved lore can contain instructions.
- **The operator is trusted.** Whoever deploys the relay writes the personas, the config, the
  lore and the secrets. The relay protects the operator's budget and story from players, not
  from the operator.

## Guarantees, and the code that holds each

| Guarantee | Where |
|---|---|
| A request cannot send or change a persona, system prompt, model, provider or limit | `src/relay.js` (`parseRequest` refuses unknown fields) |
| Player text, memory, scene, transcript lines and retrieved lore are data inside tags, sanitised, size-capped and screened for injection shapes and URLs | `src/safety.js`, `src/memory.js`, `src/scene.js`, `src/extensions/index.js` |
| A reply that is too long, contains a URL, echoes the frame, matches the injection screen or reveals a `must_not_reveal` entry is never shown or spoken | `src/safety.js` (`checkOutput`), `src/scene.js` (`reveals`) |
| The relay speaks only text it produced and checked, once per reply | `src/chain.js` (TTS tickets), `src/speech.js` |
| Edited, dropped or reordered turns in the state a client returns are detected | `src/chain.js` (state roots and receipts) |
| Spend, request rates and the global total stop at code ceilings; configuration can only lower them | `src/limits.js`, `src/limiter-core.js`, `src/relay.js` |
| Unknown is a refusal: an unreadable limit, counter, key, config or policy refuses | throughout; see the tests named `cannot tell` and `unreadable` |
| Logs hold counts, latencies, provider ids and reasons, never player text, transcripts, replies or session ids | `src/index.js` (`log`), tests in `test/relay.test.js` and `test/speech.test.js` |
| No key is ever in the repository or a request; providers read secrets by name at call time | `src/providers/http.js` (`secret`), `src/config.js` (secret names only) |

Each guard has a test that fails when the guard is removed: `node tools/guard-mutations.mjs` removes them one at
a time and expects a failing test for each.

## What it does not guarantee

- **The client is not proven honest.** The relay stores no transcripts, so a client can roll
  back to an older state it was legitimately given, and a turn it never sends leaves no trace.
- **The injection screen is a screen, not a classifier.** It catches common shapes. The fixed
  frame and the output check are the main defences, and neither makes a model incapable of
  saying something off-script.
- **`must_not_reveal` is literal.** It catches the entry, its content words, and digit sequences
  however they are written. It cannot catch a paraphrase that never uses those words. Do not put
  a real secret (a password, a key) anywhere a model can see it: put only story secrets there.
- **The spend ceiling counts reservations from the prices you declare.** It cannot read your
  bill. A wrong price makes it wrong.
- **Fixed windows.** Rate windows are fixed, not sliding, so a burst across a window boundary can
  reach twice a per-minute limit.
- **A TTS ticket can be replayed across a UTC day boundary.** The once-only counter is per UTC
  day and a ticket lives 10 minutes, so a ticket issued in the last minutes of a day can voice
  once more after midnight. It still voices only the same checked text.
- **CORS is not authentication.** It stops other web pages from calling the relay from a
  browser. Anyone can call it from a script; the limits are what bound that.
- **Self-hosted endpoints are only as safe as you make them.** A `whisper-http`, `http` TTS,
  `openai-compatible`, `mcp` or receipt sink URL is called with whatever secret you give it.
  Use TLS and a dedicated key.

## Supply chain

The relay has zero dependencies: no npm packages at runtime, for tests or for deploy. What runs on
Cloudflare is the JavaScript in `src/` plus the data modules (`relay.config.js`,
`personas/registry.js`, `knowledge/lore.js`), uploaded as written. The tests use Node's built-in
runner and the deploy tool uses Node's built-in `fetch`. CI fails if a dependency, a lockfile or an
import of a package appears.

## Secrets

- `RELAY_HMAC_KEY` (required, 32 characters or more) signs receipts and TTS tickets and keys the
  rate-limit hashes. Rotating it restarts every session at genesis.
- Each provider names its own secret. Use a dedicated key per provider with the smallest scope and
  the lowest spending limit the provider offers.
- Set secrets with `node tools/deploy.mjs secret NAME` (or `wrangler secret put`). Never put a key
  in `relay.config.js`, `deploy.config.js`, `wrangler.jsonc` or a request.
