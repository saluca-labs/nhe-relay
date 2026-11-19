// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Employee login: issue and verify short-lived bearer tokens that an MCP harness carries
// on every request to the relay /mcp endpoint.
//
// Token format: base64url(payload) DOT hex(HMAC-SHA256(key, payload))
// Payload: { emp: employee_id, ent: entity_id, exp: epoch_seconds }
//
// The token is stateless: the relay stores nothing, so verification is a fresh HMAC over the
// payload with the relay key, a constant-time compare, and an expiry check. A token from a
// different key, a tampered payload, or one past its expiry is null.

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function b64urlDecode(str) {
  return Buffer.from(str, "base64url");
}

async function hmacHex(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function constTimeEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function issueToken(hmacKey, opts) {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const exp = now + opts.ttlSec;
  const payload = JSON.stringify({ emp: opts.employeeId, ent: opts.entityId, exp });
  const payloadB64 = b64urlEncode(enc.encode(payload));
  const sig = await hmacHex(hmacKey, payloadB64);
  return { token: payloadB64 + "." + sig, exp };
}

export async function verifyToken(hmacKey, token, now) {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacHex(hmacKey, payloadB64);
  if (!constTimeEq(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
  } catch {
    return null;
  }
  if (typeof payload.emp !== "string" || typeof payload.ent !== "string" || typeof payload.exp !== "number") return null;
  const t = Math.floor((now ?? Date.now()) / 1000);
  if (payload.exp <= t) return null;
  return { employeeId: payload.emp, entityId: payload.ent, exp: payload.exp };
}

export function extractBearer(headerValue) {
  if (typeof headerValue !== "string") return null;
  const trimmed = headerValue.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const tok = trimmed.slice(7).trim();
  return tok.length > 0 ? tok : null;
}