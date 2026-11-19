# T3.11: Isolated workspace per task (D21 item 6)

**The Atom - Systems Architect - 2026-11-19**

## Problem

Every agent task must run in its own workspace: a fresh git worktree or sandbox, never shared
between tasks, cleaned on completion. When a task is re-dispatched and finds a leftover
workspace from a previous run, the relay must refuse to reuse it unless it is provably the
task own and has nothing unpushed. This is the program runner leftover rule.

## Design

The relay stores nothing. The caller (the harness or the program runner) holds each sealed
workspace revision and its receipt. The relay seals and verifies the workspace lifecycle
using the same hash chain and HMAC receipt primitives as the turn log, the walkthrough and
the plan.

### workspace_id

Derived deterministically: `SHA-256(entity_id + NUL + task_id)`. The same pair always
produces the same id. Two different task_ids produce different ids, so a workspace is never
shared between tasks. Two different entity_ids also produce different ids, so a workspace is
never shared between agents.

### Lifecycle

Each workspace has a hash-chained lifecycle:

```
root_0 = genesis(entity_id, "workspace/" + task_id)
root_n = nextRoot(root_{n-1}, event_n)
```

Events: `created` (revision 0, status active), `reused` (status stays active), `cleaned`
(status transitions to cleaned).

### Operations

| Operation | What it does | Refuses when |
|---|---|---|
| `createWorkspace` | Starts a fresh chain at revision 0, status active | Invalid fields |
| `reuseLeftover` | Chains a reuse event onto an active leftover | Not the task own, unpushed commits, uncommitted changes, already cleaned, unknown push state |
| `cleanWorkspace` | Transitions active to cleaned | Already cleaned, wrong entity, invalid receipt |

### Leftover rule (enforced in code)

`reuseLeftover` refuses unless every condition is provably true:

1. The workspace receipt verifies under the relay HMAC key (provably the relay own).
2. The workspace entity_id matches the requesting identity (provably the task own).
3. The workspace task_id matches the requesting task (provably the task own).
4. `unpushed_commits === 0` AND `uncommitted_changes === false` (nothing unpushed).
5. The workspace status is active (not already cleaned).

Unknown is a refusal, never a pass: if `unpushed_commits` or `uncommitted_changes` is
missing or the wrong type, the reuse is refused.

### MCP tools

Three tools exposed to harnesses:

- `soul.workspace_create` - seal a workspace creation
- `soul.workspace_reuse` - seal a workspace reuse (with the leftover rule check)
- `soul.workspace_clean` - seal a workspace cleanup

Each returns `{ workspace, receipt }` where `workspace` is the sealed revision and `receipt`
is the HMAC receipt.

### Verification

`verifyWorkspaceRevision` checks a single revision: digest, receipt, and valid status.
`verifyWorkspaceHistory` replays the full chain from genesis: every root recomputes, every
prev_digest links, revisions are consecutive, and the workspace_id is consistent.

## Files

- `src/harness/workspace.js` - the core module
- `src/harness/tools.js` - three MCP tool definitions added
- `src/harness/mcp-server.js` - dispatch and handler added
- `test/workspace.test.js` - 39 tests, 7 planted faults shown RED first
- `tools/guard-mutations.mjs` - 7 mutation guards added

## Planted faults

| Fault | What it breaks | Tests turned RED |
|---|---|---|
| W1 | workspace_id derived from task_id only | 1 (entity isolation) |
| W2 | cleanWorkspace allows re-cleaning | 1 (double clean) |
| W3 | reuseLeftover accepts unpushed_commits > 0 | 2 (direct + MCP) |
| W4 | reuseLeftover accepts uncommitted_changes === true | 1 |
| W5 | reuseLeftover accepts undefined unpushed_commits | 1 (cannot tell) |
| W6 | reuseLeftover accepts wrong entity_id | 1 |
| W7 | reuseLeftover accepts a cleaned workspace | 1 |