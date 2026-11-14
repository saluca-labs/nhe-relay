// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Policy adapter slot for Tiresias, a self-hosted zero-trust and cost-defense stack.
// STUB: see ARCHITECTURE.md, "Tiresias adapter status". Until a documented decision interface is
// wired here, a config that selects this policy refuses every provider call (fail closed): a
// policy that cannot be asked cannot say yes.

import type { PolicyProvider } from "./types";

export interface TiresiasEntry {
  url: string;
  secret?: string;
  timeoutMs: number;
}

export function tiresiasPolicy(_e: TiresiasEntry): PolicyProvider {
  return {
    kind: "tiresias",
    decide: async () => ({ allow: false, reason: "tiresias_adapter_not_implemented" }),
    onReceipt: async () => {},
  };
}
