// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Hash-chained turn log and the relay's receipt over client-held state.
//
// state_root_new = SHA-256( bytes(state_root_old) || UTF-8(canonical(turn)) )
//   bytes(state_root_old) is the 32 raw bytes of the previous root (decoded from lowercase hex).
//   canonical() is RFC 8785 (JCS) over the value domain this relay emits: objects, arrays,
//   strings, booleans, null and safe integers. Keys are sorted by UTF-16 code units, strings are
//   serialised with the ECMAScript JSON string rule as raw UTF-8 (RFC 8785 section 3.2.2.2), and
//   there is no whitespace. Non-integer numbers and lone surrogates are refused, not normalised.
//
// genesis(persona_id, session_id) = SHA-256( UTF-8(canonical({kind, v, persona_id, session_id})) )
//
// What the chain proves: the sequence of turns the client reports is continuous. Each root
// commits to every earlier turn the relay answered for this session, in order, so a dropped,
// reordered or edited turn changes every later root.
// What it does NOT prove: that the client is honest. The relay stores nothing, so a client can
// replay an older (root, memory, receipt) triple it was legitimately given (a rollback), and a
// client that never sends a turn leaves no trace. The receipt only shows that the triple the
// client sends was issued by this relay with this key.

export const CHAIN_VERSION = 1;
const GENESIS_KIND = "nhe-relay/genesis";
const RECEIPT_KIND = "nhe-relay/receipt";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export class CanonicalError extends Error {}

function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

export function canonical(v: Json): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new CanonicalError("only safe integers are canonicalised");
    return String(v);
  }
  if (typeof v === "string") {
    if (hasLoneSurrogate(v)) throw new CanonicalError("lone surrogate");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "object") {
    const keys = Object.keys(v).sort(); // default sort compares UTF-16 code units, as RFC 8785 requires
    return "{" + keys.map((k) => canonical(k) + ":" + canonical((v as Record<string, Json>)[k])).join(",") + "}";
  }
  throw new CanonicalError("unsupported type");
}

const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function isRootHex(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

export function fromHex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new CanonicalError("bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function genesis(persona_id: string, session_id: string): Promise<string> {
  return sha256Hex(enc.encode(canonical({ kind: GENESIS_KIND, v: CHAIN_VERSION, persona_id, session_id })));
}

export interface TurnRecord {
  [k: string]: Json;
  v: number;
  persona_id: string;
  session_id: string;
  turn_index: number;
  player_text: string;
  npc_text: string;
  memory_sha256: string;
  scene_sha256: string | null;
  knowledge_sha256: string | null; // digest of the grounding passages the model saw, or null
}

export async function nextRoot(prevRoot: string, turn: TurnRecord): Promise<string> {
  if (!isRootHex(prevRoot)) throw new CanonicalError("previous root is not 64 lowercase hex");
  const prev = fromHex(prevRoot);
  const body = enc.encode(canonical(turn));
  const buf = new Uint8Array(prev.length + body.length);
  buf.set(prev, 0);
  buf.set(body, prev.length);
  return sha256Hex(buf);
}

export async function memoryDigest(memory: Json): Promise<string> {
  return sha256Hex(enc.encode(canonical(memory)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface ReceiptFields {
  persona_id: string;
  session_id: string;
  state_root: string;
  turn_count: number;
  memory_sha256: string;
}

function receiptMessage(f: ReceiptFields): Uint8Array {
  return enc.encode(canonical({ kind: RECEIPT_KIND, v: CHAIN_VERSION, ...f }));
}

export async function issueReceipt(secret: string, f: ReceiptFields): Promise<string> {
  const key = await hmacKey(secret);
  return toHex(await crypto.subtle.sign("HMAC", key, receiptMessage(f)));
}

export async function checkReceipt(secret: string, f: ReceiptFields, receipt: unknown): Promise<boolean> {
  if (typeof receipt !== "string" || !/^[0-9a-f]{64}$/.test(receipt)) return false;
  const key = await hmacKey(secret);
  return crypto.subtle.verify("HMAC", key, fromHex(receipt), receiptMessage(f)); // constant time
}

/** Domain-separated keyed hash for rate-limit keys, so no raw IP or session id is stored. */
export async function keyedId(secret: string, domain: string, value: string): Promise<string> {
  const key = await hmacKey(secret);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(domain + "\u0000" + value))).slice(0, 32);
}

// TTS tickets. /v1/turn issues one for each reply that passed the output check; /v1/tts voices
// only text that carries a valid, unexpired ticket. So the relay never speaks text it did not
// produce and check itself, whatever a client sends.
const TTS_KIND = "nhe-relay/tts";

export interface TtsTicketFields {
  persona_id: string;
  session_id: string;
  state_root: string;
  text_sha256: string;
  exp: number; // unix seconds
}

function ttsMessage(f: TtsTicketFields): Uint8Array {
  return enc.encode(canonical({ kind: TTS_KIND, v: CHAIN_VERSION, ...f }));
}

export async function textDigest(text: string): Promise<string> {
  return sha256Hex(enc.encode(text));
}

export async function issueTtsTicket(secret: string, f: TtsTicketFields): Promise<string> {
  const key = await hmacKey(secret);
  return toHex(await crypto.subtle.sign("HMAC", key, ttsMessage(f)));
}

export async function checkTtsTicket(secret: string, f: TtsTicketFields, ticket: unknown): Promise<boolean> {
  if (typeof ticket !== "string" || !/^[0-9a-f]{64}$/.test(ticket)) return false;
  const key = await hmacKey(secret);
  return crypto.subtle.verify("HMAC", key, fromHex(ticket), ttsMessage(f)); // constant time
}
