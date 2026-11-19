// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Knowledge grant enforcement (D20b). An employee's grants control which MCP tools they
// may call through the relay. Grants use simple glob patterns:
//   "*"             matches every tool
//   "soul.*"        matches every tool whose name starts with "soul."
//   "knowledge.recall"  matches exactly that tool
//
// The relay checks grants AFTER the Tiresias policy check and BEFORE dispatching to a
// backend. A call without the matching grant is denied with a receipt, so the audit chain
// records the refusal.

/**
 * Test whether a single grant pattern matches a tool name.
 * @param {string} grant
 * @param {string} toolName
 * @returns {boolean}
 */
export function grantMatches(grant, toolName) {
  if (grant === "*") return true;
  if (grant.endsWith(".*")) {
    const prefix = grant.slice(0, -2);
    return toolName === prefix || toolName.startsWith(prefix + ".");
  }
  return grant === toolName;
}

/**
 * Test whether any grant in the list authorises the tool.
 * @param {string[]} grants
 * @param {string} toolName
 * @returns {boolean}
 */
export function hasGrant(grants, toolName) {
  if (!Array.isArray(grants) || grants.length === 0) return false;
  return grants.some(g => grantMatches(g, toolName));
}