// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Client for the Tiresias decision contract tiresias.enterprise.decision/v1 (T2.11, against
// salucallc/tiresias-zt POST /cp/enterprise/decision). The contract is vendored under
// contracts/tiresias-enterprise-decision and the golden pairs replayed in
// test/tiresias-contract.test.js.
//
// Caller rules, from the contract: proceed ONLY on HTTP 200 with decision "allow"; route
// "supervised" to approval and do not proceed; refuse "deny", any other decision, any non-200,
// a body that does not carry this contract, and any transport failure. No Tiresias
// configuration, or no admin key, is a refusal, never an allow.

export const CONTRACT = "tiresias.enterprise.decision/v1";

/**
 * Build the request body for one tool call. Tool arguments are sent as given.
 * @param {{agent: string, pathPrefix: string}} cfg
 * @param {{employeeId: string}} identity
 * @param {string} toolName
 * @param {object} args
 */
export function buildDecisionRequest(cfg, identity, toolName, args) {
  return {
    contract: CONTRACT,
    agent: cfg.agent,
    acting_as: identity.employeeId,
    method: "POST",
    path: `${cfg.pathPrefix}/${toolName}`,
    tool: { name: toolName, arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {} }
  };
}

/**
 * Ask Tiresias for a decision. Never throws.
 * @returns {Promise<{action: "proceed"|"request_approval"|"refuse", reason: string, decision?: object}>}
 */
export async function decide(deps, harness, identity, toolName, args) {
  const cfg = harness?.tiresias;
  if (!cfg) return { action: "refuse", reason: "tiresias_not_configured" };
  const key = deps.env?.[cfg.secret];
  if (typeof key !== "string" || key.length === 0)
    return { action: "refuse", reason: "tiresias_admin_key_missing" };
  let resp;
  try {
    resp = await deps.fetcher(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Admin-Key": key },
      body: JSON.stringify(buildDecisionRequest(cfg, identity, toolName, args)),
      signal: AbortSignal.timeout(cfg.timeoutMs)
    });
  } catch {
    return { action: "refuse", reason: "tiresias_unreachable" };
  }
  if (resp.status !== 200) return { action: "refuse", reason: "tiresias_error" };
  let body;
  try {
    body = await resp.json();
  } catch {
    return { action: "refuse", reason: "tiresias_bad_response" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { action: "refuse", reason: "tiresias_bad_response" };
  if (body.contract !== CONTRACT) return { action: "refuse", reason: "tiresias_contract_mismatch" };
  const why = typeof body.reason === "string" && body.reason ? body.reason : undefined;
  switch (body.decision) {
    case "allow": return { action: "proceed", reason: why ?? "allow", decision: body };
    case "supervised": return { action: "request_approval", reason: why ?? "supervised", decision: body };
    case "deny": return { action: "refuse", reason: why ?? "tiresias_deny", decision: body };
    default: return { action: "refuse", reason: "tiresias_unknown_decision" };
  }
}
