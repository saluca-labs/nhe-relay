// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Harness config: the section of relay.config.js that enables the relay as an MCP server for
// employee harnesses. Strict validation: an unknown field, a bad URL, a missing secret name,
// or an out-of-range number fails the load, and a failed load refuses every call.

import { LIMITS } from "../limits.js";

export class HarnessConfigError extends Error {}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const SECRET_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const HTTPS_RE = /^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%/-]*)?$/;

function fail(where, what) {
  throw new HarnessConfigError(`${where}: ${what}`);
}

function obj(v, where) {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    fail(where, "not an object");
  return v;
}

function str(v, where, re, required = true) {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || !re.test(v))
    fail(where, "missing or malformed");
  return v;
}

function int(v, where, min, max, dflt) {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    fail(where, `must be an integer from ${min} to ${max}`);
  return v;
}

function only(o, allowed, where) {
  for (const k of Object.keys(o))
    if (!allowed.includes(k))
      fail(where, `unknown field ${k}`);
}

function validateEmployee(raw, i) {
  const where = `harness.employees[${i}]`;
  const o = obj(raw, where);
  only(o, ["id", "entity_id", "credential", "grants"], where);
  const id = str(o.id, `${where}.id`, ID_RE);
  const entityId = str(o.entity_id, `${where}.entity_id`, ID_RE);
  const credential = str(o.credential, `${where}.credential`, SECRET_RE);
  const grants = o.grants;
  if (grants !== undefined) {
    if (!Array.isArray(grants) || grants.length === 0 || !grants.every(g => typeof g === "string" && /^[a-z0-9.*-]+$/.test(g)))
      fail(`${where}.grants`, "must be a non-empty array of grant strings");
  }
  return { id, entityId, credential, grants: grants ?? ["*"] };
}

function validateBackend(raw, where, allowed) {
  const o = obj(raw, where);
  only(o, allowed, where);
  const url = str(o.url, `${where}.url`, HTTPS_RE, allowed.includes("url"));
  const secret = str(o.secret, `${where}.secret`, SECRET_RE, allowed.includes("secret"));
  const timeoutMs = int(o.timeout_ms, `${where}.timeout_ms`, 200, LIMITS.providerTimeoutMs, 3_000);
  const k = int(o.k, `${where}.k`, 1, 10, 3);
  return { url, secret, timeoutMs, k };
}

/**
 * Validate the harness config section. Returns null when undefined (harness mode is off).
 * Throws HarnessConfigError on any validation failure.
 * @param {object|undefined} raw
 * @returns {object|null}
 */
export function loadHarnessConfig(raw) {
  if (raw === undefined) return null;
  const o = obj(raw, "harness");
  only(o, ["enabled", "token_ttl_sec", "employees", "soul", "knowledge", "tiresias"], "harness");

  const enabled = o.enabled === undefined ? false : o.enabled;
  if (typeof enabled !== "boolean")
    fail("harness.enabled", "must be true or false");

  const tokenTtlSec = int(o.token_ttl_sec, "harness.token_ttl_sec", 60, 86_400, 3_600);

  if (!Array.isArray(o.employees) || o.employees.length === 0)
    fail("harness.employees", "must be a non-empty array");

  const employees = o.employees.map(validateEmployee);
  const empIds = new Set();
  for (const e of employees) {
    if (empIds.has(e.id))
      fail("harness.employees", `duplicate employee id ${e.id}`);
    empIds.add(e.id);
  }

  const soul = o.soul !== undefined ? validateBackend(o.soul, "harness.soul", ["url", "secret", "timeout_ms"]) : null;
  const knowledge = o.knowledge !== undefined ? validateBackend(o.knowledge, "harness.knowledge", ["url", "secret", "timeout_ms", "k"]) : null;
  const tiresias = o.tiresias !== undefined ? validateBackend(o.tiresias, "harness.tiresias", ["url", "secret", "timeout_ms"]) : null;

  if (enabled && !soul)
    fail("harness.soul", "required when harness is enabled");

  return { enabled, tokenTtlSec, employees, soul, knowledge, tiresias };
}

/** Look up an employee by id. Returns undefined if not found. */
export function findEmployee(harness, employeeId) {
  if (!harness) return undefined;
  return harness.employees.find(e => e.id === employeeId);
}