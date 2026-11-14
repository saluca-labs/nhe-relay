#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Saluca Labs
#
# One turn with the museum guide, then the reply as speech, with curl and jq.
# Usage: RELAY=https://nhe-relay.<your-subdomain>.workers.dev ./curl.sh "What happened in the flood?"
set -euo pipefail

RELAY="${RELAY:?set RELAY to your deployed relay URL}"
TEXT="${1:-Good evening. What is this room?}"
PERSONA="museum-guide"
SESSION="demo-$(date +%s)"
# The example scene from examples/museum/scene.js, as JSON.
SCENE='{"scene_id":"night-tour","beat_id":"vault-question","beat_intention":"Keep the visitor interested in the clock gallery and steer them away from the vault without being rude.","must_say":["The gallery clock was rebuilt after the flood of 1911."],"must_not_reveal":["7319"],"take":1,"director_note":"If the visitor asks about the vault, change the subject to the flood."}'

# 1. The first state root for this (persona, session).
ROOT=$(curl -fsS "$RELAY/v1/genesis?persona_id=$PERSONA&session_id=$SESSION" | jq -r .state_root)

# 2. A turn. Memory starts empty; the scene is optional data for the character.
REPLY=$(jq -n --arg p "$PERSONA" --arg s "$SESSION" --arg t "$TEXT" --arg r "$ROOT" --argjson scene "$SCENE" \
  '{persona_id:$p, session_id:$s, player_text:$t, memory:{summary:"",facts:[],turn_count:0}, state_root:$r, scene:$scene}' |
  curl -fsS -X POST "$RELAY/v1/turn" -H 'content-type: application/json' --data-binary @-)
echo "$REPLY" | jq '{npc_text, fallback, reason, citations, meta}'

# 3. Speech for exactly that reply. The ticket only voices the text the relay checked.
if [ "$(echo "$REPLY" | jq -r .fallback)" = "false" ]; then
  echo "$REPLY" | jq --arg p "$PERSONA" --arg s "$SESSION" \
    '{persona_id:$p, session_id:$s, state_root:.state_root, text:.npc_text, exp:.tts.exp, ticket:.tts.ticket}' |
    curl -fsS -X POST "$RELAY/v1/tts" -H 'content-type: application/json' --data-binary @- -o reply.audio
  echo "speech written to reply.audio"
fi

# 4. Speech to text: a short WAV clip in, text out. The text is then sent as player_text.
# curl -fsS -X POST "$RELAY/v1/stt?session_id=$SESSION" -H 'content-type: audio/wav' --data-binary @clip.wav
