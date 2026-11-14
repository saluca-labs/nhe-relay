// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

export default {
  "_note": "Every provider kind in one file, to copy from. Order is the fallback order. Secrets are NAMES of Worker secrets, set with wrangler secret put NAME; never values. Prices here are placeholders to replace with the current price of your provider; a provider without a price does not load.",
  "llm": [
    {
      "id": "claude",
      "kind": "anthropic",
      "model": "claude-opus-5-5",
      "secret": "ANTHROPIC_API_KEY",
      "effort": "low",
      "max_tokens": 2048,
      "fallbacks": true,
      "timeout_ms": 8000,
      "price": {
        "input_usd_per_mtok": 4,
        "output_usd_per_mtok": 20
      }
    },
    {
      "id": "ollama",
      "kind": "ollama-cloud",
      "model": "gpt-oss:20b",
      "secret": "OLLAMA_API_KEY",
      "timeout_ms": 4000,
      "price": {
        "flat": true
      }
    },
    {
      "id": "openrouter-free",
      "kind": "openrouter",
      "model": "google/gemma-4-26b-a4b-it:free",
      "secret": "OPENROUTER_API_KEY",
      "free_only": true,
      "timeout_ms": 4000,
      "price": {
        "flat": true
      }
    },
    {
      "id": "my-vllm",
      "kind": "openai-compatible",
      "base_url": "https://llm.example.com/v1",
      "model": "my-model",
      "secret": "MY_LLM_KEY",
      "json_mode": true,
      "timeout_ms": 4000,
      "price": {
        "flat": true
      }
    },
    {
      "id": "workers-llama",
      "kind": "workers-ai",
      "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "timeout_ms": 4000,
      "price": {
        "input_usd_per_mtok": 0.293,
        "output_usd_per_mtok": 2.253
      }
    }
  ],
  "stt": [
    {
      "id": "deepgram",
      "kind": "deepgram",
      "model": "nova-3",
      "secret": "DEEPGRAM_API_KEY",
      "language": "en",
      "timeout_ms": 5000,
      "price": {
        "usd_per_minute": 0.01
      }
    },
    {
      "id": "openai-stt",
      "kind": "openai-compatible",
      "base_url": "https://api.openai.com/v1",
      "model": "whisper-1",
      "secret": "OPENAI_API_KEY",
      "timeout_ms": 6000,
      "price": {
        "usd_per_minute": 0.01
      }
    },
    {
      "id": "my-whisper",
      "kind": "whisper-http",
      "url": "https://whisper.example.com/inference",
      "field": "file",
      "timeout_ms": 6000,
      "price": {
        "flat": true
      }
    },
    {
      "id": "workers-whisper",
      "kind": "workers-ai",
      "model": "@cf/openai/whisper-large-v3-turbo",
      "timeout_ms": 6000,
      "price": {
        "usd_per_minute": 0.0005
      }
    }
  ],
  "tts": [
    {
      "id": "elevenlabs",
      "kind": "elevenlabs",
      "model": "eleven_flash_v2_5",
      "voice": "YOUR_VOICE_ID",
      "secret": "ELEVENLABS_API_KEY",
      "format": "mp3",
      "timeout_ms": 5000,
      "price": {
        "usd_per_mchar": 100
      }
    },
    {
      "id": "azure",
      "kind": "azure",
      "region": "westus2",
      "voice": "en-US-AvaNeural",
      "secret": "AZURE_SPEECH_KEY",
      "format": "wav",
      "timeout_ms": 5000,
      "price": {
        "usd_per_mchar": 16
      }
    },
    {
      "id": "my-piper",
      "kind": "http",
      "shape": "piper",
      "url": "https://tts.example.com/",
      "format": "wav",
      "timeout_ms": 5000,
      "price": {
        "flat": true
      }
    },
    {
      "id": "my-chatterbox",
      "kind": "http",
      "shape": "openai-speech",
      "url": "https://chatterbox.example.com/v1/audio/speech",
      "model": "chatterbox",
      "voice": "default",
      "format": "wav",
      "timeout_ms": 8000,
      "price": {
        "flat": true
      }
    },
    {
      "id": "workers-aura",
      "kind": "workers-ai",
      "model": "@cf/deepgram/aura-2-en",
      "voice": "luna",
      "format": "wav",
      "timeout_ms": 6000,
      "price": {
        "usd_per_mchar": 30
      }
    }
  ],
  "turn_budget_ms": 10000,
  "max_output_tokens": 300,
  "spend": {
    "daily_usd_ceiling": 5
  },
  "cors": {
    "origins": [
      "https://html-classic.itch.zone"
    ],
    "allow_localhost": true
  }
};
