// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// The three optional extension points that sit beside the LLM, STT and TTS providers. Each has a
// built-in default, so the relay runs alone with no outside service:
//
//   PolicyProvider     asked before every provider call; told about every receipt.
//                      Default: "builtin" (allow; the built-in guards already ran).
//   KnowledgeProvider  grounding passages for a persona, with citations.
//                      Default: "none". Built in: "local" (a lore module bundled with the Worker).
//   ReceiptSink        where each chained turn receipt goes after the reply is built.
//                      Default: "log" (the response carries the receipt; the log gets the root).
//
// An extension can only NARROW what the relay does. A policy can deny a call the built-in guards
// allowed; it can never allow one they refused, because it is asked only after they pass.
// Retrieved text is untrusted data: it is screened, filtered against must_not_reveal and capped
// before a model sees it, exactly like memory and player text.
// This module holds JSDoc types only.

/**
 * @typedef {object} PolicyRequest
 * @property {"turn" | "judge" | "stt" | "tts"} route
 * @property {string | null} persona_id
 * @property {string} provider_id
 * @property {string} provider_kind
 * @property {string} model
 * @property {number} estimate_micros
 */

/** @typedef {{ allow: true } | { allow: false, reason: string }} PolicyDecision */

/**
 * @typedef {object} Receipt
 * @property {"turn"} kind
 * @property {string} persona_id
 * @property {string} session_hash keyed hash of the session id, never the raw id
 * @property {number} turn_index
 * @property {string} prev_root
 * @property {string} state_root
 * @property {string} receipt the relay's HMAC over (root, turn count, memory digest)
 * @property {string | null} provider
 * @property {string | null} model
 * @property {number} ms
 */

/**
 * @typedef {object} PolicyProvider
 * @property {string} kind
 * @property {(req: PolicyRequest) => Promise<PolicyDecision>} decide
 * @property {(r: Receipt) => Promise<void>} onReceipt
 */

/**
 * @typedef {object} Passage
 * @property {string} id stable citation id, for example "lore:3" or a source document id
 * @property {string} source a short human-readable source label
 * @property {string} text
 * @property {string} [notice] a licence or attribution notice the source requires to travel with the text
 */

/** @typedef {{ persona_id: string, query: string, k: number }} KnowledgeRequest */

/** @typedef {{ kind: string, retrieve(req: KnowledgeRequest): Promise<Passage[]> }} KnowledgeProvider */

/** @typedef {{ kind: string, emit(r: Receipt): Promise<void> }} ReceiptSink */

export {};
