// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// A relay credential for tests: well-formed (tzr_<16 hex>_<64 hex>), generated fresh on every run,
// never issued by any Tiresias. No credential value is checked into this repository.

import { randomBytes } from "node:crypto";

export const freshRelayCredential = () =>
  `tzr_${randomBytes(8).toString("hex")}_${randomBytes(32).toString("hex")}`;

export const TEST_RELAY_CREDENTIAL = freshRelayCredential();
