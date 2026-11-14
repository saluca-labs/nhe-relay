// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

import { costMicros, tokensFor } from "../types.js";

/** @typedef {{ id: string, kind: string, model: string, timeoutMs: number, price: import("../types.js").Price }} LlmEntryBase */
export function llmEstimate(price, req) {
    return costMicros(price, { inTokens: tokensFor(req.system.length + req.user.length), outTokens: req.maxOutputTokens });
}
/** The OpenAI chat-completions response shape, shared by OpenRouter and compatible servers. */
export function chatCompletionText(j) {
    const c = j?.choices?.[0]?.message?.content;
    return typeof c === "string" ? c : null;
}
