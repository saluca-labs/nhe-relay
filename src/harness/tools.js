// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// The MCP tool catalog the relay exposes to harnesses (Claude Code, OpenCode, Codex, Cursor).
// Each tool brokers one backend: soul-svc, Asphodel knowledge, or Tiresias policy.
// Every tool call is authenticated (bearer token from /v1/login), policy-checked by Tiresias,
// and receipted (the relay issues a chained receipt for every call, per D20).

/**
 * @typedef {object} McpTool
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema JSON Schema for the tool arguments
 * @property {(args: object, ctx: ToolContext) => Promise<McpToolResult>} call
 */

/**
 * @typedef {object} ToolContext
 * @property {string} employeeId
 * @property {string} entityId
 * @property {object} env
 * @property {function} fetcher
 * @property {function} log
 * @property {object} harnessConfig
 * @property {function} issueReceipt
 * @property {function} policyCheck
 */

/**
 * @typedef {object} McpToolResult
 * @property {boolean} isError
 * @property {Array<{type: string, text: string}>} content
 * @property {object} [structuredContent]
 */

export const PROTOCOL_VERSION = "2025-06-18";

/**
 * The tool catalog. Names are prefixed by backend: soul.*, knowledge.*, tiresias.*.
 * The harness sees these via tools/list and calls them via tools/call.
 */
export const TOOLS = [
  {
    name: "soul.session_init",
    description: "Initialize a soul session for the employee entity. Returns a session id and the genesis state root.",
    inputSchema: {
      type: "object",
      properties: {
        persona: { type: "string", description: "The persona id for this entity" }
      },
      required: ["persona"]
    }
  },
  {
    name: "soul.memory_search",
    description: "Search the entity personal memory partition. Returns passages ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        k: { type: "integer", description: "Max results (1-10)", minimum: 1, maximum: 10 }
      },
      required: ["query"]
    }
  },
  {
    name: "soul.memory_write",
    description: "Write a memory to the entity personal partition. The content is encrypted at rest by soul-svc.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory content to persist" },
        topics: { type: "array", items: { type: "string" }, description: "Topic tags for routing" }
      },
      required: ["content"]
    }
  },
  {
    name: "soul.identity",
    description: "Return the entity identity: id, label, scopes, and anchor count.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "soul.walkthrough",
    description: "Submit a task walkthrough artifact with evidence (D21). Every agent task ends with a walkthrough: a summary, files touched, command output, and turn receipt links. The artifact is hashed into the turn chain with an HMAC receipt. A task with no evidence is marked no_evidence and is never reported as done.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task identifier, e.g. T3.05" },
        summary: { type: "string", description: "A summary of what was done" },
        files_touched: { type: "array", items: { type: "string" }, description: "Paths of files modified or created" },
        command_output: { type: "string", description: "Test or build output as evidence" },
        turn_receipts: { type: "array", items: { type: "string" }, description: "HMAC receipt hex strings from tool calls in this task" },
        requested_outcome: { type: "string", description: "Requested outcome: done, blocked, or no_evidence. Forced to no_evidence when evidence is empty." }
      },
      required: ["task_id", "summary"]
    }
  },
  {
    name: "soul.plan_post",
    description: "Post a plan before work starts (D21 item 2). The employee comments on it inline and presses Proceed through the approval surface. Each step names an action; gated actions (send, publish, schedule, deploy, push, merge, delete, pay, file, submit, external_write, queued_action) become proposals, a decision card each, and are listed up front. An unmapped action is refused. Proceed releases only the ungated steps.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task identifier, e.g. T3.07" },
        summary: { type: "string", description: "What the plan sets out to do" },
        steps: {
          type: "array",
          description: "The planned steps, in order",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Step id, 1-32 of A-Z a-z 0-9 _ -" },
              text: { type: "string", description: "What the step does" },
              action: { type: "string", description: "read, search, analyze, edit, test, draft (ungated) or a gated action" },
              gated: { type: "boolean", description: "Mark an ungated step as gated. A gated action can never be marked ungated." }
            },
            required: ["id", "text", "action"]
          }
        }
      },
      required: ["task_id", "summary", "steps"]
    }
  },
  {
    name: "soul.plan_revise",
    description: "Revise a posted plan (D21 item 2), answering the employee's open comments. Pass the current sealed revision and its receipt; the relay verifies them and returns the next revision, chained to the last. Summary and steps default to the current ones.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "object", description: "The current sealed plan revision" },
        receipt: { type: "string", description: "The receipt of the current revision" },
        summary: { type: "string", description: "The revised summary" },
        steps: { type: "array", items: { type: "object" }, description: "The revised steps" },
        answers: { type: "array", items: { type: "string" }, description: "Ids of the open comments this revision answers, e.g. c1" }
      },
      required: ["plan", "receipt"]
    }
  },
  {
    name: "soul.workspace_create",
    description: "Create a fresh isolated workspace for a task (D21 item 6). The workspace_id is derived from (entity_id, task_id) and is unique per task, so two tasks never share a workspace. The relay seals the creation into its own hash chain with an HMAC receipt. The caller holds the sealed artifact.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task identifier, e.g. T3.11" },
        repo: { type: "string", description: "The repository full name or path" },
        branch: { type: "string", description: "The branch name for this task" },
        path: { type: "string", description: "The worktree or sandbox path" }
      },
      required: ["task_id", "repo", "branch", "path"]
    }
  },
  {
    name: "soul.workspace_reuse",
    description: "Reuse a leftover workspace (D21 item 6). Refuses unless the workspace is provably the task own (receipt verifies, entity_id and task_id match) and nothing is unpushed (unpushed_commits === 0 and uncommitted_changes === false). Unknown push state is a refusal, never a pass.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "object", description: "The current sealed workspace revision" },
        receipt: { type: "string", description: "The receipt for the current revision" },
        task_id: { type: "string", description: "The task identifier" },
        unpushed_commits: { type: "integer", description: "Number of unpushed commits (must be 0)" },
        uncommitted_changes: { type: "boolean", description: "Whether there are uncommitted changes (must be false)" }
      },
      required: ["workspace", "receipt", "task_id", "unpushed_commits", "uncommitted_changes"]
    }
  },
  {
    name: "soul.workspace_clean",
    description: "Clean a workspace on task completion (D21 item 6). Transitions the workspace from active to cleaned. A cleaned workspace cannot be reused or cleaned again. Requires a valid receipt and the requesting identity must match.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "object", description: "The current sealed workspace revision" },
        receipt: { type: "string", description: "The receipt for the current revision" }
      },
      required: ["workspace", "receipt"]
    }
  },
  {
    name: "knowledge.recall",
    description: "Retrieve passages from the curated company knowledge sets (Asphodel). Context-only or content+context depending on entity grants.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        k: { type: "integer", description: "Max results (1-5)", minimum: 1, maximum: 5 }
      },
      required: ["query"]
    }
  },
  {
    name: "tiresias.policy_check",
    description: "Check whether a proposed action is allowed by the Tiresias enterprise policy. Returns allow or deny with a reason.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "The action intent, e.g. model_call, tool_call, data_read" },
        model: { type: "string", description: "The model id, if the intent is model_call" }
      },
      required: ["intent"]
    }
  }
];

/** Return the tool names as an array. */
export function toolNames() {
  return TOOLS.map(t => t.name);
}

/** Find a tool by name. Returns undefined if not found. */
export function findTool(name) {
  return TOOLS.find(t => t.name === name);
}
