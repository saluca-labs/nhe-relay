// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

import { costMicros, tokensFor, type LlmRequest, type Price } from "../types";

export interface LlmEntryBase {
  id: string;
  kind: string;
  model: string;
  timeoutMs: number;
  price: Price;
}

export function llmEstimate(price: Price, req: LlmRequest): number {
  return costMicros(price, { inTokens: tokensFor(req.system.length + req.user.length), outTokens: req.maxOutputTokens });
}

/** The OpenAI chat-completions response shape, shared by OpenRouter and compatible servers. */
export function chatCompletionText(j: unknown): string | null {
  const c = (j as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : null;
}
