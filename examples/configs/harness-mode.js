// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

{
  "_note": "Example relay config for harness mode (D20). The relay acts as an MCP server that harnesses (Claude Code, OpenCode, Codex, Cursor) connect to. It brokers soul-svc (memory, identity, session), Asphodel knowledge, and Tiresias policy. Copy into relay.config.js and adjust URLs and secret names.",
  "llm": [
    {
      "id": "primary",
      "kind": "openai-compatible",
      "base_url": "https://tiresias-proxy.customer.internal/v1",
      "model": "gpt-4o",
      "timeout_ms": 8000,
      "price": { "flat": true }
    }
  ],
  "turn_budget_ms": 15000,
  "max_output_tokens": 2048,
  "spend": {
    "daily_usd_ceiling": 50
  },
  "cors": {
    "origins": [],
    "allow_localhost": false
  },
  "policy": {
    "kind": "tiresias",
    "url": "https://tiresias.customer.internal/api",
    "secret": "TIRESIAS_RELAY_KEY",
    "timeout_ms": 1000
  },
  "harness": {
    "enabled": true,
    "token_ttl_sec": 3600,
    "employees": [
      {
        "id": "emp-001",
        "entity_id": "agent-emp-001",
        "credential": "EMP_001_CREDENTIAL",
        "grants": ["soul.*", "knowledge.recall", "tiresias.policy_check"]
      }
    ],
    "soul": {
      "url": "https://soul-svc.customer.internal/mcp",
      "secret": "SOUL_RELAY_KEY",
      "timeout_ms": 5000
    },
    "knowledge": {
      "url": "https://mindsets.asphodel.ai/mcp",
      "secret": "ASPHODEL_TOKEN",
      "timeout_ms": 5000,
      "k": 3
    },
    "tiresias": {
      "url": "https://tiresias.customer.internal/cp/enterprise/decision",
      "secret": "TIRESIAS_ADMIN_KEY",
      "agent": "customer-agent-slug",
      "path_prefix": "/mcp/tools",
      "timeout_ms": 1000
    }
  }
}