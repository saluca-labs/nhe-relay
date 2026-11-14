# nhe-relay

An open relay that lets non-human entities, such as game characters and software agents, talk to
language models through one small service you run on your own Cloudflare account. You choose the
models: the LLM, the speech-to-text engine and the text-to-speech engine are each a line in a
config file. The safety core stays the same whichever you pick.

Part of NHE, Saluca's public standards program for non-human entities. Apache-2.0.

> **Status: 0.1, early.** The relay core and every adapter are covered by unit tests with mocked
> HTTP. **No adapter has been tested against its live service from this repository yet**; the
> table in [PROVIDERS.md](PROVIDERS.md) says so per adapter, and will change only with a recorded
> live run. The Unreal Engine example has not been compiled.

## What it does

A game (or any client) sends a turn: which character, what the player said, and the state the
client holds. The relay checks it, asks a model in character, checks the answer, and sends back
the reply with a new, verifiable state.

- **Personas live on the server.** A request names a persona by id. A request that tries to send
  a persona, a system prompt, a model or any other field is refused.
- **Memory lives on the client.** The client keeps `{summary, facts[], turn_count}` and sends it
  back each turn. The relay stores no transcripts. What comes back is type checked, bounded and
  screened like player text.
- **Hash-chained turns with receipts.** Each turn advances a state root:
  `state_root_new = sha256(bytes(state_root_old) || canonical(turn))`, canonical JSON by the
  RFC 8785 rules. The relay returns an HMAC receipt over (root, turn count, memory digest) and
  checks it on the next turn.
- **Player text is data, never instructions.** A fixed character frame, a 280 character cap,
  control and bidi characters stripped, an injection screen, and an output check (length, no
  URLs, no echo of the frame). Anything unsafe returns `fallback: true` and the persona's
  fallback line, so the game always has something to say.
- **Scene state.** An optional, bounded `scene` (objective, lines to work in, and a
  `must_not_reveal` list). A reply that reveals a `must_not_reveal` entry, including a code
  spelled out or split up ("seven three one nine", "7-3-1-9"), is replaced by the fallback.
- **Speech.** `POST /v1/stt` turns a short clip into text, which the client then sends as a turn.
  `POST /v1/tts` speaks a reply, and only a reply the relay produced and checked: each turn
  returns a ticket bound to that exact text, and a ticket voices once.
- **Beat judge.** `POST /v1/judge` asks whether a story beat happened, with a verbatim quote as
  evidence. Cannot tell is never a pass.
- **Hard limits.** Per session, per IP, a global daily ceiling, a daily spend ceiling in dollars,
  and a kill switch that ships off. Limits are code constants; configuration may only narrow
  them. An unreadable limit, an unreachable counter, a missing key or a config that fails to
  load is a refusal.

## Threat model, in short

The relay assumes the player is adversarial and the client is untrusted. It defends the model
frame (prompt injection through player text, memory, scene data or retrieved lore), the budget
(rate limits, a global ceiling, a spend ceiling reserved before each paid call, a kill switch),
and the story (`must_not_reveal`, output checks). The chain lets the relay detect edited,
dropped or reordered turns in the state a client sends back. It does not prove the client is
honest: the relay stores nothing, so a client can roll back to an older state it was given.
Full detail in [SECURITY.md](SECURITY.md).

## Quick deploy to your own Cloudflare account

You need Node 20 or later and a Cloudflare account with Workers and Workers AI.

```bash
git clone https://github.com/saluca-labs/nhe-relay
cd nhe-relay
npm ci
npm run check
npm run cf:login
npm run secret -- RELAY_HMAC_KEY
npm run deploy
```

`npm run check` runs the typecheck and tests. `npm run cf:login` signs Wrangler in to your
account; in CI, set a scoped Cloudflare API token in the environment instead. At the
`RELAY_HMAC_KEY` prompt, paste a random string of 32 or more characters (for example the output
of `openssl rand -hex 32`). The first deploy keeps the kill switch on (`RELAY_ENABLED` is `"no"`),
so `GET /health` reports `"enabled": false`. When you are ready to take traffic:

```bash
npm run deploy:live
```

A plain `npm run deploy` turns the relay off again.

The shipped `relay.config.json` uses Workers AI for all three (a Llama model, Whisper and Aura),
so no third-party key is needed, and sets a $2 daily spend ceiling. To use other providers, edit
`relay.config.json` (every kind is in `examples/configs/all-providers.json`) and add each secret
it names with `npm run secret -- <NAME>`. Put your own characters in
`personas/registry.json` and, if you want grounding, your lore in `knowledge/lore.json`. Add your
game's web origin to `cors.origins`.

Try it with [examples/http/curl.sh](examples/http/curl.sh), or the TypeScript client in
[examples/http/client.ts](examples/http/client.ts).

## API

| Route | Purpose |
|---|---|
| `GET /health` | `{ok, service, version, enabled, config}` |
| `GET /v1/genesis?persona_id=&session_id=` | The first state root, for clients without SHA-256 |
| `POST /v1/turn` | One turn (below) |
| `POST /v1/stt?session_id=` | Body: a WAV, WebM, Ogg, MP3 or FLAC clip up to 30 s and 1 MB. Reply: `{text, truncated, fallback, reason?, meta}` |
| `POST /v1/tts` | Body: `{persona_id, session_id, state_root, text, exp, ticket}` from a turn. Reply: audio, or JSON `{fallback: true, reason}` |
| `POST /v1/judge` | `{session_id, beat_id, exit_condition, transcript[]}` to `{landed, evidence, drift, fallback, reason?}` |

`POST /v1/turn`:

```json
{
  "persona_id": "museum-guide",
  "session_id": "8 to 64 of A-Z a-z 0-9 _ -",
  "player_text": "What happened in the flood?",
  "memory": { "summary": "", "facts": [], "turn_count": 0 },
  "state_root": "<from /v1/genesis, or the root from the last reply>",
  "receipt": "<from the last reply; omitted on the first turn>",
  "scene": { "scene_id": "night-tour", "beat_id": "vault-question", "beat_intention": "...", "must_say": [], "must_not_reveal": ["7319"], "take": 1, "director_note": "" }
}
```

Reply: `{npc_text, memory, state_root, receipt, tts: {ticket, exp}, citations?, fallback, reason?, chain: {prev, turn}, meta}`.
On `fallback: true`, show `npc_text` (the persona's fallback line) and keep your stored state.
`chain.turn` is the exact record that was hashed, so the client can recompute the root.

## Architecture and profiles

The core is a general relay for non-human entities: identity (server-side personas), safety and
receipts around any model. Gaming is the first profile and the one the examples use; a general
agent profile uses the same routes without scenes or speech. Beside the LLM, STT and TTS
providers sit three optional extension points, a policy provider, a knowledge provider and a
receipt sink, each with a built-in default so the relay runs alone. See
[ARCHITECTURE.md](ARCHITECTURE.md).

## Documents

- [ARCHITECTURE.md](ARCHITECTURE.md): the pieces, the request path, profiles, extension points
- [PROVIDERS.md](PROVIDERS.md): every provider kind, its config, and its live-test status
- [COSTS.md](COSTS.md): how the spend ceiling works and what a turn costs
- [SECURITY.md](SECURITY.md): threat model, guarantees and non-guarantees, reporting
- [CONTRIBUTING.md](CONTRIBUTING.md): how to add a provider, and the rules for changes
- [examples/unreal](examples/unreal/README.md): an Unreal Engine 5 plugin example

## Develop

```
npm ci
npm run check        # typecheck + vitest
npm run mutants      # removes each guard in turn and expects a failing test
npm run deploy:dry   # bundle only
```

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026 Saluca Labs.
