// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Drift check for the vendored tiresias.enterprise.decision/v1 contract files.
// Default: every vendored file must hash to the value pinned in PIN.json (offline, exit 1 on
// drift, so a hand edit turns CI red). With --fetch: also download each file from the pinned
// commit of the source repo (needs GITHUB_TOKEN or GH_TOKEN for a private repo) and require it
// to be byte-identical to the vendored copy. A fetch that cannot be done is a failure, never a pass.
// Usage: node tools/check-contract-pin.mjs [--fetch] [--dir <contracts dir>]

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const doFetch = args.includes("--fetch");
const di = args.indexOf("--dir");
const dir = di >= 0 ? args[di + 1] : join(here, "..", "contracts", "tiresias-enterprise-decision");

const sha = buf => createHash("sha256").update(buf).digest("hex");
const pin = JSON.parse(readFileSync(join(dir, "PIN.json"), "utf8"));
const problems = [];

for (const [rel, meta] of Object.entries(pin.files)) {
  let local;
  try {
    local = readFileSync(join(dir, rel));
  } catch (e) {
    problems.push(`${rel}: unreadable (${e.code ?? e.message})`);
    continue;
  }
  if (sha(local) !== meta.sha256)
    problems.push(`${rel}: vendored copy hashes to ${sha(local)}, pin says ${meta.sha256}`);
  if (doFetch) {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const url = `https://api.github.com/repos/${pin.source_repo}/contents/${meta.source_path}?ref=${pin.source_commit}`;
    try {
      const resp = await fetch(url, {
        headers: {
          accept: "application/vnd.github.raw+json",
          "user-agent": "nhe-relay-contract-pin",
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        signal: AbortSignal.timeout(20_000)
      });
      if (!resp.ok) { problems.push(`${rel}: fetch from pinned commit failed, HTTP ${resp.status}`); continue; }
      const remote = Buffer.from(await resp.arrayBuffer());
      if (sha(remote) !== sha(local))
        problems.push(`${rel}: differs from ${pin.source_repo}@${pin.source_commit.slice(0, 7)}`);
    } catch (e) {
      problems.push(`${rel}: fetch failed (${e.message})`);
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error("contract pin: " + p);
  process.exit(1);
}
console.log(`contract pin ok: ${Object.keys(pin.files).length} files${doFetch ? ", matched source at pinned commit" : ""}`);
