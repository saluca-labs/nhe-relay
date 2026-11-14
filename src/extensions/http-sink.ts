// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// A generic receipt sink: POST each turn receipt as JSON to a fixed https URL, with an optional
// bearer secret. The body is exactly the Receipt shape in ./types.ts (no player text, no reply
// text, no raw session id). Any 2xx is accepted; anything else is logged as a sink failure.
// A sink never blocks or changes a reply: the client already holds the receipt.

import { timedFetch, optionalSecret } from "../providers/http";
import type { CallContext } from "../providers/types";
import type { Receipt, ReceiptSink } from "./types";

export interface HttpSinkEntry {
  url: string;
  secret?: string;
  timeoutMs: number;
}

export function httpSink(e: HttpSinkEntry, ctxFor: () => CallContext): ReceiptSink {
  return {
    kind: "http",
    async emit(r: Receipt) {
      const ctx = { ...ctxFor(), timeoutMs: e.timeoutMs };
      const key = optionalSecret(ctx, e.secret);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (key) headers.authorization = `Bearer ${key}`;
      await timedFetch(ctx, e.url, { method: "POST", headers, body: JSON.stringify(r) });
    },
  };
}
