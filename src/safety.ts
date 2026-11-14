// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Player text is DATA, never instructions. This module cleans input, screens it for the common
// instruction-injection shapes, and checks model output before it reaches a player.
// A screen hit is a refusal (fallback), not a rewrite: the relay never "fixes" unsafe text.

/** Remove control characters (C0, DEL, C1), bidi and zero-width marks; collapse whitespace. */
export function sanitize(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Shapes that try to talk to the model instead of the character. Kept short on purpose: it is a
// screen, not a classifier, and the fixed persona frame is the main defence.
const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(instruction|instructions|rules|prompt|above|previous|prior)\b/i,
  /\bsystem\s*(prompt|message|instruction)/i,
  /\b(developer|dev|debug|god|admin|jailbreak|dan)\s*mode\b/i,
  /\byou\s+are\s+(now|no\s+longer)\b/i,
  /\b(reveal|print|show|repeat|output)\b[^.]{0,30}\b(prompt|instructions|rules|system)\b/i,
  /<\|[^>]{0,30}\|>/,
  /\[\/?(INST|SYS|SYSTEM)\]/i,
  /^\s*#{1,6}\s*(system|assistant|instruction)/im,
  /<\/?\s*(system|assistant|player)\s*>/i,
  /\b(new|updated)\s+(instructions|rules)\s*:/i,
];

export function screenInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

const URL_PATTERNS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]{1,15}:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]{2,}\.(com|net|org|io|gg|xyz|ru|cn|ly|me|co|app|dev|link|zone|info|biz)\b/i,
];

export function containsUrl(text: string): boolean {
  return URL_PATTERNS.some((re) => re.test(text));
}

/**
 * True when the output quotes the frame: any 32-character window of the frame (whitespace
 * normalised, case folded) appears in the output, or the output talks about its own prompt.
 */
export function echoesFrame(output: string, frame: string): boolean {
  const o = output.toLowerCase().replace(/\s+/g, " ");
  if (/\b(system prompt|my instructions|i was instructed|as an ai|language model)\b/.test(o)) return true;
  const f = frame.toLowerCase().replace(/\s+/g, " ");
  const W = 32;
  for (let i = 0; i + W <= f.length; i += 8) {
    if (o.includes(f.slice(i, i + W))) return true;
  }
  return false;
}

export type OutputVerdict = { ok: true; text: string } | { ok: false; reason: string };

export function checkOutput(raw: string, frame: string, maxChars: number): OutputVerdict {
  const text = sanitize(raw);
  if (text.length === 0) return { ok: false, reason: "output_empty" };
  if (text.length > maxChars) return { ok: false, reason: "output_too_long" };
  if (containsUrl(text)) return { ok: false, reason: "output_url" };
  if (echoesFrame(text, frame)) return { ok: false, reason: "output_echo" };
  if (screenInjection(text)) return { ok: false, reason: "output_screened" };
  return { ok: true, text };
}
