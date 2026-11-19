// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Leaver export (D20b, SALUCA-009, SALUCA-033). When an employee leaves, their personal
// partition is exported as a hash-only bundle: content hashes, topic tags, timestamps,
// counts and a chain head. The bundle verifies against the company copy (the company can
// re-hash its records and compare), but it cannot recover content: every entry is a
// SHA-256 digest, not the original text.
//
// The export is sealed with an HMAC receipt so its integrity is independently verifiable.
// A read-back probe (a query as the retired entity) is expected to be denied, because the
// entity's credentials are invalidated at Tiresias and the relay's token has expired or
// been revoked.

import { sha256Hex, canonical, issueReceipt, checkReceipt, toHex } from "../chain.js";

const enc = new TextEncoder();

/**
 * Create a hash-only leaver export from an employee's personal memories.
 *
 * @param {string} hmacKey - the relay HMAC key, used for the seal receipt
 * @param {object} employee - { id, entityId, memories: [{content, topics, ts}], exportedAt }
 * @returns {Promise<{exportRecord: object, receipt: string}>}
 */
export async function createLeaverExport(hmacKey, employee) {
  const entries = [];
  for (const m of employee.memories) {
    entries.push({
      content_hash: await sha256Hex(enc.encode(m.content)),
      topics: m.topics ?? [],
      ts: m.ts
    });
  }
  const count = entries.length;
  const chainHead = await sha256Hex(enc.encode(canonical(entries)));
  const exportedAt = employee.exportedAt ?? Math.floor(Date.now() / 1000);
  const exportRecord = {
    entity_id: employee.entityId,
    employee_id: employee.id,
    entries,
    count,
    chain_head: chainHead,
    exported_at: exportedAt
  };
  const receipt = await issueReceipt(hmacKey, {
    entity_id: employee.entityId,
    session_hash: chainHead,
    tool: "leaver_export",
    outcome: "exported",
    ts: exportedAt
  });
  return { exportRecord, receipt };
}

/**
 * Verify a leaver export against the company's copy of the personal memories.
 *
 * Checks:
 * 1. The count matches.
 * 2. Every content hash in the export matches a fresh hash of the company copy's content.
 * 3. The chain head matches a fresh hash of the entries.
 * 4. The receipt verifies under the same HMAC key.
 *
 * @param {string} hmacKey
 * @param {object} exportRecord - the hash-only bundle
 * @param {object} companyCopy - { memories: [{content, topics, ts}] }
 * @param {string} receipt - the HMAC receipt from createLeaverExport
 * @returns {Promise<boolean>}
 */
export async function verifyLeaverExport(hmacKey, exportRecord, companyCopy, receipt) {
  if (!Array.isArray(companyCopy.memories)) return false;
  if (exportRecord.count !== companyCopy.memories.length) return false;
  if (exportRecord.entries.length !== companyCopy.memories.length) return false;

  for (let i = 0; i < companyCopy.memories.length; i++) {
    const expected = await sha256Hex(enc.encode(companyCopy.memories[i].content));
    if (exportRecord.entries[i].content_hash !== expected) return false;
    const expTopics = companyCopy.memories[i].topics ?? [];
    const gotTopics = exportRecord.entries[i].topics ?? [];
    if (expTopics.length !== gotTopics.length) return false;
    for (let j = 0; j < expTopics.length; j++) {
      if (expTopics[j] !== gotTopics[j]) return false;
    }
    if ((companyCopy.memories[i].ts ?? null) !== (exportRecord.entries[i].ts ?? null)) return false;
  }

  const expectedHead = await sha256Hex(enc.encode(canonical(exportRecord.entries)));
  if (exportRecord.chain_head !== expectedHead) return false;

  const receiptOk = await checkReceipt(hmacKey, {
    entity_id: exportRecord.entity_id,
    session_hash: exportRecord.chain_head,
    tool: "leaver_export",
    outcome: "exported",
    ts: exportRecord.exported_at
  }, receipt);
  if (!receiptOk) return false;

  return true;
}

/**
 * Confirm that an export record is hash-only: no entry contains a recoverable content field,
 * and every content_hash is a valid 64-char lowercase hex digest.
 *
 * @param {object} exportRecord
 * @returns {boolean}
 */
export function isHashOnly(exportRecord) {
  if (!Array.isArray(exportRecord.entries)) return false;
  for (const entry of exportRecord.entries) {
    if (typeof entry.content === "string") return false;
    if (!/^[0-9a-f]{64}$/.test(entry.content_hash)) return false;
  }
  return true;
}