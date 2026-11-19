// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

import { describe, it, expect } from "./expect.js";
import { issueToken, verifyToken, extractBearer } from "../src/harness/login.js";

const HMAC = "test-only-hmac-key-0123456789abcdef0123456789";
const NOW = 1_700_000_000_000; // epoch ms

describe("login: token issue and verify", () => {
  it("issues a token that verifies back to the same identity", async () => {
    const { token, exp } = await issueToken(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      ttlSec: 3600,
      now: NOW
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(exp).toBe(1_700_003_600);

    const identity = await verifyToken(HMAC, token, NOW);
    expect(identity).toEqual({
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      exp: 1_700_003_600
    });
  });

  it("rejects a token signed with a different key", async () => {
    const { token } = await issueToken(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      ttlSec: 3600,
      now: NOW
    });
    const identity = await verifyToken("a-completely-different-key-xxxxxxxxxxxxxxxx", token, NOW);
    expect(identity).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { token } = await issueToken(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      ttlSec: 100,
      now: NOW
    });
    // 200 seconds later: past expiry
    const identity = await verifyToken(HMAC, token, NOW + 200_000);
    expect(identity).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const { token } = await issueToken(HMAC, {
      employeeId: "emp-001",
      entityId: "agent-emp-001",
      ttlSec: 3600,
      now: NOW
    });
    // Flip the first character of the payload to alter it
    const tampered = (token[0] === "e" ? "Z" : "e") + token.slice(1);
    const identity = await verifyToken(HMAC, tampered, NOW);
    expect(identity).toBeNull();
  });

  it("rejects a malformed token (no dot, empty parts)", async () => {
    expect(await verifyToken(HMAC, "nodothere", NOW)).toBeNull();
    expect(await verifyToken(HMAC, ".", NOW)).toBeNull();
    expect(await verifyToken(HMAC, "abc.", NOW)).toBeNull();
    expect(await verifyToken(HMAC, ".abc", NOW)).toBeNull();
    expect(await verifyToken(HMAC, null, NOW)).toBeNull();
    expect(await verifyToken(HMAC, 42, NOW)).toBeNull();
  });
});

describe("login: bearer extraction", () => {
  it("extracts a bearer token from an Authorization header", () => {
    expect(extractBearer("Bearer abc123")).toBe("abc123");
    expect(extractBearer("bearer abc123")).toBe("abc123");
    expect(extractBearer("  Bearer   abc123  ")).toBe("abc123");
  });

  it("returns null for a non-bearer header", () => {
    expect(extractBearer("Basic abc123")).toBeNull();
    expect(extractBearer("")).toBeNull();
    expect(extractBearer(null)).toBeNull();
    expect(extractBearer("Bearer ")).toBeNull();
  });
});
