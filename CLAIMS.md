# Claims

Every capability the public docs state, mapped to the code that does it, where it is wired, and
the test that proves it. Checked by the merge gate on every pull request.

| id | claim | source | status | code | wired | test | note |
|---|---|---|---|---|---|---|---|
| C1 | Personas live on the server. | README.md | shipped | src/relay.ts::parseRequest | src/relay.ts: await parseRequest(body) | test/relay.test.ts::refuses any attempt to send a persona, system prompt, model or provider | |
| C2 | Memory lives on the client. | README.md | shipped | src/memory.ts::validateMemory | src/relay.ts: validateMemory(b.memory) | test/units.test.ts::accepts a well-formed memory | |
| C3 | The relay stores no transcripts. | README.md | shipped | src/limiter.ts::Limiter | src/index.ts: stub.take(rules) | test/relay.test.ts::logs counts and provider, never the player text or session id | the Durable Object holds counters only |
| C4 | Hash-chained turns with receipts. | README.md | shipped | src/chain.ts::nextRoot | src/relay.ts: nextRoot(req.state_root, turn) | test/chain.test.ts::recomputes as sha256 over the previous root bytes then the canonical turn | |
| C5 | checks it on the next turn | README.md | shipped | src/chain.ts::checkReceipt | src/relay.ts: await checkReceipt(key | test/relay.test.ts::later turns need a receipt over exactly this root, count and memory | |
| C6 | Player text is data, never instructions. | README.md | shipped | src/safety.ts::screenInjection | src/relay.ts: screenInjection(req.player_text) | test/relay.test.ts::screens injection shapes and URLs with a fallback, without calling the model | |
| C7 | is replaced by the fallback | README.md | shipped | src/scene.ts::reveals | src/relay.ts: reveals(verdict.text, req.scene.must_not_reveal) | test/scene-judge.test.ts::matches a code however it is spaced, punctuated or spelled out | must_not_reveal, including spelled-out codes |
| C8 | a ticket voices once | README.md | shipped | src/speech.ts::handleTts | src/index.ts: await handleTts(body, ip, env, deps) | test/speech.test.ts::voices the exact reply a turn produced, once | |
| C9 | Cannot tell is never a pass. | README.md | shipped | src/judge.ts::parseJudge | src/judge.ts: parseJudge(result.value, transcript) | test/scene-judge.test.ts::an unparsable judge reply is landed:false with a reason, never a pass | |
| C10 | configuration may only narrow | README.md | shipped | src/limits.ts::narrowed | src/relay.ts: narrowed("globalPerDay", env.GLOBAL_DAILY_CEILING) | test/units.test.ts::accepts the default and smaller values, refuses larger or malformed ones | |
| C11 | a daily spend ceiling in dollars | README.md | shipped | src/relay.ts::spendHook | src/relay.ts: const spend = spendHook(env, cfg, deps) | test/relay.test.ts::a paid provider whose reservation would cross the ceiling is skipped and the next one answers | |
| C12 | a kill switch that ships off | README.md | shipped | src/relay.ts::switchedOff | src/relay.ts: const off = switchedOff(env, deps) | test/relay.test.ts::refuses every call unless RELAY_ENABLED is exactly yes, and never calls a provider | wrangler.jsonc ships RELAY_ENABLED "no" |
| C13 | cannot be reached is a deny | ARCHITECTURE.md | shipped | src/providers/run.ts::runChain | src/relay.ts: policy: (p) => policy.decide | test/extensions.test.ts::a policy that throws, or denies everything, means no provider runs | |
| C14 | ships as a stub that denies every call | ARCHITECTURE.md | shipped | src/extensions/tiresias.ts::tiresiasPolicy | src/extensions/index.ts: tiresiasPolicy(cfg.policy) | test/extensions.test.ts::the Tiresias slot is a fail-closed stub until a decision interface exists | |
| C15 | A failed retrieval means no lore | ARCHITECTURE.md | shipped | src/extensions/index.ts::cleanPassages | src/relay.ts: knowledgeState = "unavailable" | test/extensions.test.ts::a failed retrieval means no lore this turn, never a refusal or a guess | |
| C16 | dropped whole if it carries an injection | ARCHITECTURE.md | shipped | src/extensions/index.ts::cleanPassages | src/relay.ts: cleanPassages(Array.isArray(raw) | test/extensions.test.ts::grounds the turn in cleaned passages, cites them, and commits to them in the chain | |
| C17 | A sink cannot change or block a reply | ARCHITECTURE.md | shipped | src/relay.ts::handleTurn | src/relay.ts: ext.receipts.emit(rec) | test/extensions.test.ts::a failing sink never blocks or changes the reply | |
