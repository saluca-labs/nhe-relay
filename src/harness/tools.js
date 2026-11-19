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
