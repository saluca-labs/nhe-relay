// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Client for the Tiresias decision contract tiresias.enterprise.decision/v2 (T2.11, against
// salucallc/tiresias-zt POST /cp/enterprise/decision). The contract is vendored under
// contracts/tiresias-enterprise-decision and the golden pairs replayed in
// test/tiresias-contract.test.js.
//
// Credential (v2): the relay holds ONE relay credential, `tzr_<16 hex>_<64 hex>`, issued by a
// Tiresias admin for this customer's tenant (and optionally this site), kept as a Worker secret and
// sent as `Authorization: Bearer`. It opens the decision endpoint and nothing else, and it can be
// revoked or rotated without touching any other relay. The relay never holds the Tiresias platform
// admin key, never sends X-Admin-Key, and refuses to send any secret that is not shaped like a relay
// credential (an admin key in the slot is refused before any network call).
//
// Caller rules, from the contract: proceed ONLY on HTTP 200 with decision "allow"; route
// "supervised" to approval and do not proceed; refuse "deny", any other decision, any non-200,
// a body that does not carry this contract, and any transport failure. No Tiresias
// configuration, or no relay credential, is a refusal, never an allow.

export const CONTRACT = "tiresias.enterprise.decision/v2";

/** The only secret shape the relay will send to Tiresias. */
export const RELAY_CREDENTIAL_RE = /^tzr_[0-9a-f]{16}_[0-9a-f]{64}$/;

/**
 * Build the request body for one tool call. Tool arguments are sent as given.
 * @param {{agent: string, pathPrefix: string, site?: string|null}} cfg
 * @param {{employeeId: string}} identity
 * @param {string} toolName
 * @param {object} args
 */
export function buildDecisionRequest(cfg, identity, toolName, args) {
  const body = {
    contract: CONTRACT,
    agent: cfg.agent,
    acting_as: identity.employeeId,
    method: "POST",
    path: `${cfg.pathPrefix}/${toolName}`,
    tool: { name: toolName, arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {} }
  };
  if (typeof cfg.site === "string" && cfg.site) body.site = cfg.site;
  return body;
}

/**
 * Ask Tiresias for a decision. Never throws.
 * @returns {Promise<{action: "proceed"|"request_approval"|"refuse", reason: string, decision?: object}>}
 */
export async function decide(deps, harness, identity, toolName, args) {
  const cfg = harness?.tiresias;
  if (!cfg) return { action: "refuse", reason: "tiresias_not_configured" };
  const credential = deps.env?.[cfg.secret];
  if (typeof credential !== "string" || credential.length === 0)
    return { action: "refuse", reason: "tiresias_relay_credential_missing" };
  // Never send anything but a relay credential: a platform admin key (or any other secret) put in
  // this slot by mistake is refused here, before it can leave the Worker.
  if (!RELAY_CREDENTIAL_RE.test(credential))
    return { action: "refuse", reason: "tiresias_relay_credential_malformed" };
  let resp;
  try {
    resp = await deps.fetcher(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
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
