// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Hard limits. These are code constants on purpose: configuration may only NARROW them.
// Raising any value here is a code change plus a reviewed PR, never an environment variable
// and never a line in relay.config.json.

export const LIMITS = {
  // Input bounds (characters, after sanitising).
  maxPlayerText: 280,
  maxSummary: 600,
  maxFacts: 12,
  maxFactChars: 160,
  maxTurnCount: 100_000,
  maxBodyBytes: 16_384,

  // Output bounds.
  maxNpcText: 400,

  // Speech bounds.
  maxAudioBytes: 1_000_000, // about 30 s of 16 kHz mono 16-bit WAV
  maxSttSeconds: 30, // worst case used for the spend reservation
  ttsTicketTtlSec: 600,

  // Rate limits (attempts, counted before any provider is called).
  sessionPerMinute: 6,
  sessionPerDay: 200,
  ipPerMinute: 20,
  ipPerDay: 600,

  // Global ceiling across every caller and every route. When reached, every call is refused until
  // the next UTC day: the automatic shut-off.
  globalPerDay: 5_000,

  // Spend ceiling across every provider call, in US dollars per UTC day. Each call reserves its
  // worst-case cost before it runs; when the next reservation would cross the ceiling, every paid
  // provider is refused until the next UTC day.
  spendUsdPerDay: 25,

  // Time. A provider entry may set its own timeout and the config a turn budget, up to these.
  providerTimeoutMs: 15_000,
  turnBudgetMs: 20_000,
} as const;

export type LimitName = keyof typeof LIMITS;

/**
 * Read a numeric override from configuration. It may only narrow: a value above the constant,
 * a non-integer, zero or a negative number is refused (null), and the caller treats null as
 * "cannot tell", which is a refusal.
 */
export function narrowed(name: LimitName, raw: string | number | undefined): number | null {
  const ceiling = LIMITS[name];
  if (raw === undefined || raw === "") return ceiling;
  const s = String(raw);
  if (!/^[0-9]+$/.test(s)) return null;
  const v = Number(s);
  if (!Number.isSafeInteger(v) || v <= 0 || v > ceiling) return null;
  return v;
}
