# Claims

Every capability the public docs state, mapped to the code that does it, where it is wired, and
the test that proves it. Checked by the merge gate on every pull request.

| id | claim | source | status | code | wired | test | note |
|---|---|---|---|---|---|---|---|
| C1 | Personas live on the server. | README.md | shipped | src/relay.js::parseRequest | src/relay.js: await parseRequest(body) | test/relay.test.js::refuses any attempt to send a persona, system prompt, model or provider | |
| C2 | Memory lives on the client. | README.md | shipped | src/memory.js::validateMemory | src/relay.js: validateMemory(b.memory) | test/units.test.js::accepts a well-formed memory | |
| C3 | The relay stores no transcripts. | README.md | shipped | src/limiter.js::Limiter | src/index.js: stub.fetch("https://limiter/take" | test/relay.test.js::logs counts and provider, never the player text or session id | the Durable Object holds counters only |
| C4 | Hash-chained turns with receipts. | README.md | shipped | src/chain.js::nextRoot | src/relay.js: nextRoot(req.state_root, turn) | test/chain.test.js::recomputes as sha256 over the previous root bytes then the canonical turn | |
| C5 | checks it on the next turn | README.md | shipped | src/chain.js::checkReceipt | src/relay.js: await checkReceipt(key | test/relay.test.js::later turns need a receipt over exactly this root, count and memory | |
| C6 | Player text is data, never instructions. | README.md | shipped | src/safety.js::screenInjection | src/relay.js: screenInjection(req.player_text) | test/relay.test.js::screens injection shapes and URLs with a fallback, without calling the model | |
| C7 | is replaced by the fallback | README.md | shipped | src/scene.js::reveals | src/relay.js: reveals(verdict.text, req.scene.must_not_reveal) | test/scene-judge.test.js::matches a code however it is spaced, punctuated or spelled out | must_not_reveal, including spelled-out codes |
| C8 | a ticket voices once | README.md | shipped | src/speech.js::handleTts | src/index.js: await handleTts(body, ip, env, deps) | test/speech.test.js::voices the exact reply a turn produced, once | |
| C9 | Cannot tell is never a pass. | README.md | shipped | src/judge.js::parseJudge | src/judge.js: parseJudge(result.value, transcript) | test/scene-judge.test.js::an unparsable judge reply is landed:false with a reason, never a pass | |
| C10 | configuration may only narrow | README.md | shipped | src/limits.js::narrowed | src/relay.js: narrowed("globalPerDay", env.GLOBAL_DAILY_CEILING) | test/units.test.js::accepts the default and smaller values, refuses larger or malformed ones | |
| C11 | a daily spend ceiling in dollars | README.md | shipped | src/relay.js::spendHook | src/relay.js: const spend = spendHook(env, cfg, deps) | test/relay.test.js::a paid provider whose reservation would cross the ceiling is skipped and the next one answers | |
| C12 | a kill switch that ships off | README.md | shipped | src/relay.js::switchedOff | src/relay.js: const off = switchedOff(env, deps) | test/relay.test.js::refuses every call unless RELAY_ENABLED is exactly yes, and never calls a provider | deploy.config.js ships RELAY_ENABLED "no" |
| C13 | cannot be reached is a deny | ARCHITECTURE.md | shipped | src/providers/run.js::runChain | src/relay.js: policy: (p) => policy.decide | test/extensions.test.js::a policy that throws, or denies everything, means no provider runs | |
| C14 | ships as a stub that denies every call | ARCHITECTURE.md | shipped | src/extensions/tiresias.js::tiresiasPolicy | src/extensions/index.js: tiresiasPolicy(cfg.policy) | test/extensions.test.js::the Tiresias slot is a fail-closed stub until a decision interface exists | |
| C15 | A failed retrieval means no lore | ARCHITECTURE.md | shipped | src/extensions/index.js::cleanPassages | src/relay.js: knowledgeState = "unavailable" | test/extensions.test.js::a failed retrieval means no lore this turn, never a refusal or a guess | |
| C16 | dropped whole if it carries an injection | ARCHITECTURE.md | shipped | src/extensions/index.js::cleanPassages | src/relay.js: cleanPassages(Array.isArray(raw) | test/extensions.test.js::grounds the turn in cleaned passages, cites them, and commits to them in the chain | |
| C17 | A sink cannot change or block a reply | ARCHITECTURE.md | shipped | src/relay.js::handleTurn | src/relay.js: ext.receipts.emit(rec) | test/extensions.test.js::a failing sink never blocks or changes the reply | |
