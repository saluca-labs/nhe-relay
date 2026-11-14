// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Test stub for the "cloudflare:workers" module, which only exists inside workerd.
export class DurableObject {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
