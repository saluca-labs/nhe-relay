// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// House text rules over every tracked file: no em or en dashes, no local machine paths, no
// private network names or addresses, and the SPDX header on source files.
// Usage: node tools/check-text.mjs   (exit 1 on any finding)

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const TEXT = /\.(ts|mjs|js|json|jsonc|md|sh|yml|yaml|cs|cpp|h|uplugin|txt)$|^(LICENSE|NOTICE|\.gitignore|\.gitattributes)$/;
const SOURCE = /\.(js|mjs|cs|cpp|h|sh)$/;
const SELF = "tools/check-text.mjs";

const RULES = [
  { name: "em or en dash", re: new RegExp("[\\u2013\\u2014]") },
  { name: "invisible or bidi character", re: new RegExp("[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF]") },
  { name: "Windows drive path", re: /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])/ },
  { name: "home directory path", re: /[\\/](Users|home)[\\/][a-z0-9._-]+[\\/]/i },
  { name: "tailnet host", re: /\.ts\.net\b/i },
  { name: "private network address", re: /\b(10\.\d{1,3}|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/ },
];

let bad = 0;
for (const f of files) {
  if (f === SELF || f === "package-lock.json" || f === "LICENSE") continue;
  if (!TEXT.test(f.split("/").pop()) && !TEXT.test(f)) continue;
  const text = readFileSync(f, "utf8");
  text.split("\n").forEach((line, i) => {
    for (const r of RULES) {
      if (r.re.test(line)) {
        console.log(`${f}:${i + 1}: ${r.name}`);
        bad++;
      }
    }
  });
  if (SOURCE.test(f) && !text.slice(0, 400).includes("SPDX-License-Identifier: Apache-2.0")) {
    console.log(`${f}: missing SPDX header`);
    bad++;
  }
}
console.log(bad === 0 ? `text rules: ${files.length} files clean` : `text rules: ${bad} finding(s)`);
process.exit(bad === 0 ? 0 : 1);
