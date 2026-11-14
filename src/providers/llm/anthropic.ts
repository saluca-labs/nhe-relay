// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Anthropic Messages API through the official TypeScript SDK (@anthropic-ai/sdk), with the
// Worker's fetch passed in so tests can mock HTTP. Default model claude-opus-5-5.
//
// Notes on the model family this targets (Claude Opus 5.5 and later):
// - thinking cannot be disabled; depth is set with output_config.effort. A game turn wants a
//   short answer quickly, so the default effort is "low". Thinking tokens count against
//   max_tokens, so the default max_tokens (2048) is far above the reply cap on purpose.
// - a policy decline arrives as HTTP 200 with stop_reason "refusal". The adapter opts into the
//   server-side fallback ("default") so the API can retry on another model inside the same call,
//   and maps a final refusal to ProviderError("refused"), never to a reply.
// - the SDK's own retries are off (maxRetries 0): the relay's chain and its time budget decide
//   what happens next, not a hidden retry loop.

import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, statusKind, type LlmProvider } from "../types";
import { secret } from "../http";
import { llmEstimate, type LlmEntryBase } from "./common";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export function anthropicLlm(e: LlmEntryBase & { secret: string; effort: Effort; maxTokens: number; fallbacks: boolean }): LlmProvider {
  return {
    id: e.id,
    kind: "anthropic",
    model: e.model,
    timeoutMs: e.timeoutMs,
    estimateMicros: (req) => llmEstimate(e.price, { ...req, maxOutputTokens: Math.max(req.maxOutputTokens, e.maxTokens) }),
    async complete(req, ctx) {
      const apiKey = secret(ctx, e.secret);
      const client = new Anthropic({
        apiKey,
        fetch: ctx.fetcher as unknown as typeof fetch,
        maxRetries: 0,
        timeout: ctx.timeoutMs,
      });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ctx.timeoutMs);
      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await client.beta.messages.create(
          {
            model: e.model,
            max_tokens: Math.max(req.maxOutputTokens, e.maxTokens),
            system: req.system,
            messages: [{ role: "user", content: req.user }],
            output_config: { effort: e.effort },
            ...(e.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal: ctrl.signal },
        );
      } catch (err) {
        throw mapAnthropicError(err, ctrl.signal.aborted);
      } finally {
        clearTimeout(timer);
      }
      if (msg?.stop_reason === "refusal") throw new ProviderError("refused", msg.stop_details?.category ?? "");
      if (!Array.isArray(msg?.content)) throw new ProviderError("bad_response", "shape");
      const text = msg.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (!text) throw new ProviderError("bad_response", msg.stop_reason ?? "empty");
      return text;
    },
  };
}

export function mapAnthropicError(err: unknown, aborted: boolean): ProviderError {
  if (err instanceof ProviderError) return err;
  if (aborted || err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIUserAbortError) return new ProviderError("timeout");
  if (err instanceof Anthropic.APIError && typeof err.status === "number") return new ProviderError(statusKind(err.status), `http_${err.status}`);
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError("upstream", "connection");
  return new ProviderError("upstream", err instanceof Error ? err.name : "unknown");
}
