# Providers

Providers are listed in `relay.config.json` under `llm`, `stt` and `tts`, in fallback order.
Every entry has an `id` (lowercase, unique in its list), a `kind`, a `price` (required, see
[COSTS.md](COSTS.md)) and an optional `timeout_ms` (default 4000, at most 15000). A key is
never written in the config: `secret` names a Worker secret, which you set with
`npm run secret -- <NAME>`. URLs must be https, with no query string.

A provider whose secret is missing is skipped, never called without its key. A config with an
unknown field, an unknown kind, a missing price or a malformed URL does not load, and a relay
whose config does not load refuses every call.

## Live-test status

"Unit" means request shape, response parsing, error mapping and timeout are tested against mocked
HTTP. "Live" means a recorded run against the real service from this repository. **No adapter is
tested live yet.** This table changes only with a recorded live run.

| List | Kind | Unit | Live |
|---|---|---|---|
| llm | `workers-ai` | yes (mocked binding) | untested live |
| llm | `ollama-cloud` | yes | untested live from this repository |
| llm | `openrouter` | yes | untested live from this repository |
| llm | `anthropic` | yes (official SDK, mocked fetch) | untested live |
| llm | `openai-compatible` | yes | untested live |
| stt | `workers-ai` | yes (mocked binding) | untested live |
| stt | `deepgram` | yes | untested live |
| stt | `openai-compatible` | yes | untested live |
| stt | `whisper-http` | yes | untested live |
| tts | `workers-ai` | yes (mocked binding) | untested live |
| tts | `elevenlabs` | yes | untested live |
| tts | `azure` | yes | untested live |
| tts | `http` (Piper, Chatterbox) | yes | untested live |
| knowledge | `local` | yes | n/a (in the Worker) |
| knowledge | `mcp`, `asphodel` | yes (mocked MCP server) | untested live |
| receipts | `http` | yes | untested live |
| policy | `tiresias` | stub, fails closed | n/a |

## LLM

The model is asked for JSON `{"say", "remember", "summary"}`. A reply that does not parse moves
to the next provider; if none parses, the turn is `output_shape`.

| Kind | Fields | Notes |
|---|---|---|
| `workers-ai` | `model` | Through the `AI` binding in `wrangler.jsonc`. No key. |
| `ollama-cloud` | `model`, `secret` | `https://ollama.com/api/chat`, JSON format, thinking off. |
| `openrouter` | `model`, `secret`, `free_only` (default true) | With `free_only`, a model id that does not end in `:free` is refused before any request. |
| `anthropic` | `model` (default `claude-opus-5-5`), `secret`, `effort` (default `low`), `max_tokens` (default 2048), `fallbacks` (default true) | The official `@anthropic-ai/sdk` with the Worker's fetch and SDK retries off. Thinking cannot be disabled on this model family, so depth is set with `effort` and `max_tokens` leaves room for it. A `refusal` stop reason is an error, never a reply. With `fallbacks`, the request opts into the server-side fallback (`fallbacks: "default"`), which lets the API retry a declined request on another model within the same call. |
| `openai-compatible` | `base_url`, `model`, `secret` (optional), `json_mode` (default true) | `POST {base_url}/chat/completions`. vLLM, llama.cpp server, LM Studio behind TLS, or a hosted gateway. |

## Speech to text

The relay accepts WAV, WebM, Ogg, MP3 and FLAC up to 1 MB; a WAV longer than 30 s is refused from
its header. The transcript is cleaned and capped at 280 characters (`truncated: true`), and is
returned, not acted on: the client sends it to `/v1/turn`, where every check applies.

| Kind | Fields | Notes |
|---|---|---|
| `workers-ai` | `model` (for example `@cf/openai/whisper-large-v3-turbo`), `language` | Audio sent as base64. |
| `deepgram` | `model` (for example `nova-3`), `secret`, `language` | Raw audio body, `Authorization: Token`. |
| `openai-compatible` | `base_url`, `model`, `secret`, `language` | `POST {base_url}/audio/transcriptions`, multipart. Also fits servers that copy that API. |
| `whisper-http` | `url`, `field` (default `file`), `secret` | A self-hosted Whisper (for example the whisper.cpp server's `/inference`), multipart, reads `{text}`. Put it behind TLS. |

## Text to speech

`format` is `mp3` (default) or `wav`. The Unreal example plays WAV only. `voice` is the provider
default; a persona can override it per provider id with `tts_voice` in the registry.

| Kind | Fields | Notes |
|---|---|---|
| `workers-ai` | `model` (for example `@cf/deepgram/aura-2-en`), `voice`, `format` | WAV is requested as linear16 in a wav container. |
| `elevenlabs` | `model` (for example `eleven_flash_v2_5`), `voice` (a voice id), `secret`, `format` | WAV is requested as raw 22.05 kHz PCM and wrapped in a WAV header by the relay. |
| `azure` | `region`, `voice` (for example `en-US-AvaNeural`), `secret`, `format` | SSML with the text XML-escaped; the voice name is pattern-checked. |
| `http` | `url`, `shape` (`piper` or `openai-speech`), `model`, `voice`, `secret`, `format` | `piper` posts `{text, voice?}` (the Piper HTTP server). `openai-speech` posts `{model, input, voice, response_format}` (Chatterbox API servers and others that copy the OpenAI speech API). |

## Adding a provider

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: one file under `src/providers/<list>/`, a
`kind` in `src/config.ts`, unit tests with mocked HTTP for the request, the response, every error
kind and the timeout, and a row in the table above marked untested live.
