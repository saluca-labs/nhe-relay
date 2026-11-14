// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// The three optional extension points that sit beside the LLM, STT and TTS providers. Each has a
// built-in default, so the relay runs alone with no outside service:
//
//   PolicyProvider   asked before every provider call; told about every receipt.
//                    Default: "builtin" (allow; the built-in guards already ran).
//   KnowledgeProvider  grounding passages for a persona, with citations.
//                    Default: "none". Built in: "local" (a JSON lore file bundled with the Worker).
//   ReceiptSink      where each chained turn receipt goes after the reply is built.
//                    Default: "log" (the response carries the receipt; the log gets the root).
//
// An extension can only NARROW what the relay does. A policy can deny a call the built-in guards
// allowed; it can never allow one they refused, because it is asked only after they pass.
// Retrieved text is untrusted data: it is screened, filtered against must_not_reveal and capped
// before a model sees it, exactly like memory and player text.

export interface PolicyRequest {
  route: "turn" | "judge" | "stt" | "tts";
  persona_id: string | null;
  provider_id: string;
  provider_kind: string;
  model: string;
  estimate_micros: number;
}

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

export interface Receipt {
  kind: "turn";
  persona_id: string;
  session_hash: string; // keyed hash of the session id, never the raw id
  turn_index: number;
  prev_root: string;
  state_root: string;
  receipt: string; // the relay's HMAC over (root, turn count, memory digest)
  provider: string | null;
  model: string | null;
  ms: number;
}

export interface PolicyProvider {
  kind: string;
  decide(req: PolicyRequest): Promise<PolicyDecision>;
  onReceipt(r: Receipt): Promise<void>;
}

export interface Passage {
  id: string; // stable citation id, for example "lore:3" or a source document id
  source: string; // a short human-readable source label
  text: string;
  notice?: string; // a licence or attribution notice the source requires to travel with the text
}

export interface KnowledgeRequest {
  persona_id: string;
  query: string;
  k: number;
}

export interface KnowledgeProvider {
  kind: string;
  retrieve(req: KnowledgeRequest): Promise<Passage[]>;
}

export interface ReceiptSink {
  kind: string;
  emit(r: Receipt): Promise<void>;
}
