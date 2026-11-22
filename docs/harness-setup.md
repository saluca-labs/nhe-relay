# Harness Setup Guide (D20)

This guide shows how to connect an employee AI coding harness to the customer relay, which
brokers soul-svc (memory, identity, session), Asphodel knowledge, and Tiresias policy.

Every model call is decided by Tiresias. Every turn is receipted (the relay issues a chained
HMAC receipt for each tool call). The relay stores nothing: the token is stateless, the receipt
is verifiable without storing content.

## Prerequisites

1. The relay is running on the customer infrastructure (see DEPLOY.md).
2. The relay config has a `harness` section (see `examples/configs/harness-mode.js`).
3. The employee is registered in the config with an `id`, `entity_id`, and `credential` (the
   name of an env var holding their login secret).
4. The employee has their login credential (from the customer vault, not in any config file).

## Step 1: Log in and get a bearer token

The employee logs in once (the token lasts `token_ttl_sec`, default 1 hour):

```
curl -X POST https://relay.customer.internal/v1/login \
  -H "Content-Type: application/json" \
  -d '{"employee_id":"emp-001","credential":"their-secret-value"}'
```

Response:
```json
{"token":"<bearer-token>","entity_id":"agent-emp-001","exp":1700003600}
```

The token is a signed payload: `base64url({emp,ent,exp}) . hex(HMAC-SHA256(key,payload))`.
It carries no secret value. The relay verifies it on every MCP request.

## Step 2: Connect your harness

Each harness has its own config format. Templates are in `examples/harness/`.

### Claude Code

Place at `.claude/mcp.json` in the project root (or merge into `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "saluca-relay": {
      "type": "url",
      "url": "https://relay.customer.internal/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

Template: `examples/harness/claude-code.json`

### Cursor

Place at `.cursor/mcp.json` in the project root:

```json
{
  "mcpServers": {
    "saluca-relay": {
      "type": "streamableHttp",
      "url": "https://relay.customer.internal/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

Template: `examples/harness/cursor.json`

### OpenCode

Merge into the OpenCode config file:

```json
{
  "mcp": {
    "saluca-relay": {
      "type": "streamableHttp",
      "url": "https://relay.customer.internal/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

Template: `examples/harness/opencode.json` (plain JSON, so it can be validated and parsed; merge its `mcp` entry into your own `opencode.json`, replace the URL with the customer relay address and `REPLACE_WITH_LOGIN_TOKEN` with the bearer from `/v1/login`)

### Codex CLI

Merge into `~/.codex/config.toml`:

```toml
[mcp_servers.saluca-relay]
type = "streamable-http"
url = "https://relay.customer.internal/mcp"

[mcp_servers.saluca-relay.headers]
Authorization = "Bearer <token>"
```

Template: `examples/harness/codex.toml`

## Step 3: Available tools

The relay exposes these MCP tools (visible via `tools/list`):

| Tool | Backend | Description |
|---|---|---|
| `soul.session_init` | soul-svc | Initialize a soul session, get a genesis state root |
| `soul.memory_search` | soul-svc | Search the entity personal memory partition |
| `soul.memory_write` | soul-svc | Write a memory to the entity personal partition |
| `soul.identity` | soul-svc | Return the entity identity, scopes, and anchor count |
| `knowledge.recall` | Asphodel | Retrieve passages from curated company knowledge sets |
| `tiresias.policy_check` | Tiresias | Check whether a proposed action is allowed |

Each call is:
- **Authenticated**: the bearer token resolves to the employee and entity identity.
- **Policy-checked**: Tiresias decides allow or deny before the backend is called.
- **Receipted**: the relay issues a chained HMAC receipt (in `_meta.receipt`), verifiable
  without storing content.

### Tiresias decision contract (fail closed)

`harness.tiresias` is required when the harness is enabled; a config without it refuses to load.
The relay speaks `tiresias.enterprise.decision/v1` to `POST /cp/enterprise/decision`: header
`X-Admin-Key` (the env var named by `secret`), body `{contract, agent, acting_as, method, path,
tool: {name, arguments}}` with the employee id as `acting_as`. A call proceeds only on HTTP 200
with `decision: "allow"`. `supervised` returns "Approval required" and does not run the call;
anything else, a missing admin key and any transport failure are refusals. Grants are explicit:
each employee needs a `grants` list and a bare `"*"` is refused. The contract files are vendored
from tiresias-zt at the commit in `contracts/tiresias-enterprise-decision/PIN.json`; check them
with `node tools/check-contract-pin.mjs` (add `--fetch` to compare against the pinned source).

## Step 4: Verify the connection

After connecting, the harness should be able to list tools and call them. A quick test:

```bash
# Initialize the MCP session
curl -X POST https://relay.customer.internal/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# List tools (requires bearer token)
curl -X POST https://relay.customer.internal/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## Security notes

- The bearer token is short-lived (default 1 hour). The harness needs to re-login when it expires.
- The relay stores no sessions, no tokens, no transcripts. Every verification is stateless.
- The employee credential is a secret NAME in the config (e.g. `EMP_001_CREDENTIAL`); the value
  lives in the customer vault, never in a config file or a log.
- The relay proxies to soul-svc and Asphodel over HTTPS with its own backend secrets, so the
  harness never sees the backend credentials.
- Tiresias policy is checked before every backend call. A deny returns an error result with a
  reason, and a receipt for the denied call.
