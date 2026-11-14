// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Workers AI text generation through the AI binding. No key: the binding is the credential.

import { ProviderError, type LlmProvider } from "../types";
import { timedAi } from "../http";
import { llmEstimate, type LlmEntryBase } from "./common";

export function workersAiLlm(e: LlmEntryBase): LlmProvider {
  return {
    id: e.id,
    kind: "workers-ai",
    model: e.model,
    timeoutMs: e.timeoutMs,
    estimateMicros: (req) => llmEstimate(e.price, req),
    async complete(req, ctx) {
      const out = await timedAi(ctx, e.model, {
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        max_tokens: req.maxOutputTokens,
        temperature: 0.7,
      });
      const r = (out as { response?: unknown })?.response;
      if (typeof r === "string") return r;
      if (typeof r === "object" && r !== null) return JSON.stringify(r); // some models return parsed JSON
      throw new ProviderError("bad_response", "shape");
    },
  };
}
