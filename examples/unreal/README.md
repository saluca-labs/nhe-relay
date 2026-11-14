# Unreal Engine 5 example: NheRelay plugin

A small runtime plugin with one component, `UNheRelayComponent`, that talks to an nhe-relay
persona from an actor.

> **Not compiled yet.** This example was written against the Unreal Engine 5.4 APIs (HTTP, Json,
> AudioCaptureCore, `USoundWaveProcedural`) and has not been built or run from this repository.
> Expect to fix small API differences for your engine version. Reports and fixes are welcome.

## What it shows

- **A turn over HTTP.** `Say(Text)` fetches the genesis root on first use, sends the turn, keeps
  memory, state root and receipt, and broadcasts `OnReply(Text, bFallback, Reason)`.
- **A scripted fallback.** On any failure the component still produces a line: the persona's
  fallback line when the relay sent one, otherwise the next entry of `ScriptedLines`. The game
  never waits on a model.
- **Push-to-talk.** `StartTalking()` opens the default microphone; `StopTalking()` sends the clip
  (16-bit WAV, at most 30 s) to `/v1/stt`, broadcasts `OnHeard(Text)` and sends the text as a
  turn.
- **Playback.** With `bSpeakReplies`, each checked reply is fetched from `/v1/tts` with its ticket
  and played at the owner. Playback handles 16-bit PCM WAV only, so set `"format": "wav"` on your
  TTS provider in `relay.config.js` (the shipped Workers AI config already does).

## Use

1. Copy `NheRelay/` into your project's `Plugins/` folder and regenerate project files.
2. Enable the plugin (it enables the engine's Audio Capture plugin).
3. Add `NheRelay Component` to a character actor. Set `RelayUrl` and `PersonaId`.
4. In Blueprint, bind `OnReply` to your dialogue UI, call `Say` from your text input, and bind a
   key to `StartTalking` (pressed) and `StopTalking` (released).
5. For a web (HTML5) build, add its origin to `cors.origins`. Desktop builds send no Origin
   header and need no CORS entry.

## What it does not do

It does not verify the state root on the client (the relay checks receipts on its side), does not
decode MP3, and does not stream audio.
