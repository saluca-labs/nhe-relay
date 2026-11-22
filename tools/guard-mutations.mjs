// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Confirms the tests can fail: removes one guard at a time, runs vitest, and expects at least
// one failing test under `node --test`. Restores every file afterwards, even on error.
// Usage: node tools/guard-mutations.mjs   (exit 1 if any mutant survives or cannot be applied)

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const MUTANTS = [
  { name: "kill switch removed", file: "src/relay.js", from: 'if (env.RELAY_ENABLED !== "yes") return "kill_switch";', to: "" },
  { name: "receipt check removed", file: "src/relay.js", from: 'if (!valid) return keep("chain_receipt", 400);', to: "" },
  { name: "injection screen removed", file: "src/relay.js", from: 'if (screenInjection(req.player_text) || containsUrl(req.player_text)) return keep("screened");', to: "" },
  { name: "must_not_reveal check removed", file: "src/relay.js", from: 'if (req.scene && reveals(verdict.text, req.scene.must_not_reveal)) return keep("output_reveals");', to: "" },
  { name: "digit-sequence reveal check removed", file: "src/scene.js", from: "if (d.length >= 3 && replyDigits.includes(d)) return true;", to: "" },
  { name: "output check removed", file: "src/relay.js", from: "if (!verdict.ok) return keep(verdict.reason);", to: "" },
  { name: "unknown-field refusal removed", file: "src/relay.js", from: 'for (const k of Object.keys(b)) if (!allowed.has(k)) return { ok: false, status: 400, reason: "unknown_field" };', to: "" },
  { name: "global ceiling ignored", file: "src/limiter-core.js", from: "if (c + w > rules[i].limit)", to: "if (false)" },
  { name: "narrowing allows widening", file: "src/limits.js", from: "v > ceiling", to: "false" },
  { name: "spend reservation skipped", file: "src/providers/run.js", from: "if (!admitted) {", to: "if (false) {" },
  { name: "spend env narrowing allows widening", file: "src/relay.js", from: "if (v <= 0 || v > cfg.spendCeilingMicros) return null;", to: "if (v <= 0) return null;" },
  { name: "policy deny ignored", file: "src/providers/run.js", from: "if (d.allow !== true) {", to: "if (false) {" },
  { name: "TTS ticket check removed", file: "src/speech.js", from: 'if (!(await checkTtsTicket(key, fields, b.ticket))) return refuse("ticket", 400);', to: "" },
  { name: "TTS ticket once-only removed", file: "src/speech.js", from: "const limited = await admit(env, deps, ip, b.session_id, [once]);", to: "const limited = await admit(env, deps, ip, b.session_id, []);" },
  { name: "TTS expiry check removed", file: "src/speech.js", from: 'if (b.exp < nowSec || b.exp > nowSec + LIMITS.ttsTicketTtlSec) return refuse("ticket_expired", 400);', to: "" },
  { name: "STT length cap removed", file: "src/speech.js", from: 'if (secs > LIMITS.maxSttSeconds) return refuse("audio_too_long", 413);', to: "" },
  { name: "retrieved text not screened", file: "src/extensions/index.js", from: "if (screenInjection(all) || containsUrl(all)) continue;", to: "" },
  { name: "retrieved text not filtered for secrets", file: "src/extensions/index.js", from: "if (mustNotReveal.length && reveals(all, mustNotReveal)) continue;", to: "" },
  { name: "judge evidence check removed", file: "src/judge.js", from: 'if (!transcript.some((l) => l.text.includes(ev))) return { ok: false, reason: "judge_evidence_not_in_transcript" };', to: "" },
  { name: "judge parse failure becomes a pass", file: "src/judge.js", from: 'if (a < 0 || b <= a) return { ok: false, reason: "judge_unparsable" };', to: 'if (a < 0 || b <= a) return { ok: true, landed: true, evidence: null, drift: 0 };' },
  { name: "unparsable reply no longer cascades", file: "src/relay.js", from: "(t) => parseReply(t) !== null)", to: "() => true)" },
  { name: "CORS admits any origin", file: "src/cors.js", from: "if (policy.origins.includes(origin)) return true;", to: "return true;" },
  { name: "config accepts a missing price", file: "src/config.js", from: 'const p = obj(o.price, `${where}.price`);', to: 'const p = (o.price ?? { flat: true });' },
  { name: "openrouter free-only check removed", file: "src/providers/llm/openrouter.js", from: 'if (e.freeOnly && !e.model.endsWith(":free")) throw new ProviderError("config", "not_free");', to: "" },
  { name: "plan P1: unmapped action defaults to ungated", file: "src/harness/plan.js", from: "throw new PlanError(`unmapped step action: ${action}`);", to: "return false;" },
  { name: "plan P2: agent may ungate a gated action", file: "src/harness/plan.js", from: "if (actionGated && s.gated === false) throw new PlanError(`step ${s.id}: a ${s.action} step is gated and cannot be marked ungated`);", to: "" },
  { name: "plan P3: Proceed releases gated steps", file: "src/harness/plan.js", from: "return plan.steps.filter((s) => s.gated === false).map((s) => s.id);", to: "return plan.steps.map((s) => s.id);" },
  { name: "plan P4: stale Proceed accepted", file: "src/harness/plan.js", from: 'if (event.seen_digest !== ctx.prevDigest) throw new PlanError("stale proceed: the plan changed after the revision you saw");', to: "" },
  { name: "plan P5: Proceed with unanswered comments", file: "src/harness/plan.js", from: "if (state.open_comments.length > 0) throw new PlanError(`cannot proceed: comments not yet answered by a revision: ${state.open_comments.join(\", \")}`);", to: "" },
  { name: "plan P6: event accepted from the wrong party", file: "src/harness/plan.js", from: 'if (event.by !== expectedBy) throw new PlanError(`${event.type} must come from ${fromEmployee ? "the plan\'s employee" : "the plan\'s agent"}`);', to: "" },
  { name: "plan P7: history root check removed", file: "src/harness/plan.js", from: "if (plan.root !== (await nextRoot(prevRoot, plan.event))) return { ok: false, reason: `revision_${i}_root` };", to: "" },
  { name: "plan P8: gated step left off the proposals", file: "src/harness/plan.js", from: "return steps.filter((s) => s.gated).map((s) => s.id);", to: "return steps.filter((s) => s.gated && s.action !== \"deploy\").map((s) => s.id);" },
  { name: "workspace W1: workspace_id derived from task_id only", file: "src/harness/workspace.js", from: 'return sha256Hex(enc.encode(entityId + "\\u0000" + taskId));', to: 'return sha256Hex(enc.encode(taskId));' },
  { name: "workspace W2: cleanWorkspace allows re-cleaning", file: "src/harness/workspace.js", from: 'if (plan.status !== STATUS_ACTIVE)\n    throw new WorkspaceError("workspace is already cleaned");', to: "" },
  { name: "workspace W3: reuseLeftover accepts unpushed_commits > 0", file: "src/harness/workspace.js", from: 'if (opts.unpushed_commits > 0)\n    throw new WorkspaceError("workspace has " + opts.unpushed_commits + " unpushed commits");', to: "" },
  { name: "workspace W4: reuseLeftover accepts uncommitted_changes === true", file: "src/harness/workspace.js", from: 'if (opts.uncommitted_changes !== false)\n    throw new WorkspaceError("workspace has uncommitted changes");', to: "" },
  { name: "workspace W5: reuseLeftover accepts undefined unpushed_commits", file: "src/harness/workspace.js", from: 'if (typeof opts.unpushed_commits !== "number" || !Number.isSafeInteger(opts.unpushed_commits) || opts.unpushed_commits < 0)\n    throw new WorkspaceError("unpushed_commits must be a non-negative integer");', to: "" },
  { name: "workspace W6: reuseLeftover accepts wrong entity_id", file: "src/harness/workspace.js", from: 'if (plan.entity_id !== opts.entity_id)\n    throw new WorkspaceError("workspace belongs to another entity");', to: "" },
  { name: "workspace W7: reuseLeftover accepts a cleaned workspace", file: "src/harness/workspace.js", from: 'if (plan.status !== STATUS_ACTIVE)\n    throw new WorkspaceError("workspace is not active: already cleaned");', to: "" },
  { name: "decision v2: admin-key-shaped secret sent", file: "src/harness/tiresias-decision.js", from: "if (!RELAY_CREDENTIAL_RE.test(credential))", to: "if (false)" },
  { name: "decision v2: credential sent as X-Admin-Key", file: "src/harness/tiresias-decision.js", from: 'authorization: `Bearer ${credential}`', to: '"X-Admin-Key": credential' },
  { name: "decision v2: a refusal status proceeds", file: "src/harness/tiresias-decision.js", from: 'if (resp.status !== 200) return { action: "refuse", reason: "tiresias_error" };', to: 'if (resp.status !== 200) return { action: "proceed", reason: "tiresias_error" };' },
  { name: "decision v2: a v1 answer accepted", file: "src/harness/tiresias-decision.js", from: 'if (body.contract !== CONTRACT) return { action: "refuse", reason: "tiresias_contract_mismatch" };', to: "" },
  { name: "decision v2: admin-key secret name accepted", file: "src/harness/config.js", from: "if (/ADMIN/i.test(base.secret))", to: "if (false)" },
  { name: "anthropic refusal becomes a reply", file: "src/providers/llm/anthropic.js", from: 'if (msg?.stop_reason === "refusal") throw new ProviderError("refused", msg.stop_details?.category ?? "");', to: "" },
];

// Guard text is matched with any run of whitespace standing for any other, so a reformatted
// line (a guard split over two lines) is still found.
function pattern(from) {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(esc.replace(/\s+/g, "\\s+"));
}

let bad = 0;
for (const m of MUTANTS) {
  const orig = readFileSync(m.file, "utf8");
  const re = pattern(m.from);
  if (!re.test(orig)) {
    console.log(`CANNOT TELL  ${m.name}: guard text not found in ${m.file}`);
    bad++;
    continue;
  }
  try {
    writeFileSync(m.file, orig.replace(re, () => m.to));
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap"], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    const failed = /^# fail (\d+)/m.exec(out);
    if (r.status !== 0 && failed && Number(failed[1]) > 0) console.log(`killed       ${m.name}: ${failed[1]} test(s) failed`);
    else {
      console.log(`SURVIVED     ${m.name} (exit ${r.status})`);
      console.log(out.split("\n").slice(-12).join("\n"));
      bad++;
    }
  } finally {
    writeFileSync(m.file, orig);
  }
}
console.log(bad === 0 ? `all ${MUTANTS.length} mutants killed` : `${bad} mutant(s) not killed`);
process.exit(bad === 0 ? 0 : 1);
