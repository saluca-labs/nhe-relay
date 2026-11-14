# Contributing

Thanks for helping. nhe-relay is small on purpose; changes that keep it small and checkable are
the easiest to accept.

## Before you open a pull request

```
node --test                          # every test, on Node's built-in runner
node tools/guard-mutations.mjs       # every guard still has a test that fails without it
node tools/check-text.mjs            # house text rules
node tools/deploy.mjs --dry-run      # the upload the deploy tool would send
```

Node 20 or later, nothing to install.

- Branch from `main`, keep one change per pull request, and say what you tested and how.
- New behaviour needs a test you have seen fail before your change.
- A new guard needs a mutant in `tools/guard-mutations.mjs`.
- No em dashes or en dashes in code, comments or docs; use a plain hyphen or rephrase.
- New source files start with the two-line SPDX header used everywhere else.
- **No dependencies.** Plain modern JavaScript (ES modules) that runs on the Workers runtime as
  written, types in JSDoc comments, tests on `node --test` with `node:assert`. A pull request
  that adds a package, a lockfile or a build step will be declined.
- By contributing you agree that your contribution is licensed under the Apache License 2.0.

## Rules that do not bend

These keep the relay safe whatever providers it runs. A change that loosens one will be declined.

1. **Configuration may only narrow.** Ceilings live in `src/limits.js`. Nothing read at runtime
   (config file, env var, request) may raise one.
2. **Cannot tell is a refusal.** An unreadable value, an unreachable dependency or an unmapped
   input refuses. It never takes a default.
3. **A request never chooses the persona text, the model, the provider or a limit.**
4. **No keys in the repository.** Config names secrets; adapters read them at call time.
5. **Logs never hold player text, transcripts, replies or session ids.**
6. **Untested is said out loud.** An adapter is "untested live" in PROVIDERS.md until a live run
   is recorded.

## Adding a provider

1. Write one file under `src/providers/llm/`, `src/providers/stt/` or `src/providers/tts/`
   implementing the interface in `src/providers/types.js`. Use `timedFetch` (or `timedAi`) so
   the timeout and status mapping are shared, read the key with `secret(ctx, name)`, and throw
   `ProviderError` with the right kind for every failure, including a 2xx with the wrong shape.
2. Implement `estimateMicros` from the entry's `price`, as a worst case.
3. Add the `kind` to `src/config.js` with strict field validation (`only(...)`), https-only URLs
   and a secret name, never a value.
4. Add unit tests in `test/providers.test.js` with mocked HTTP: the exact request (URL, headers,
   body), response parsing, each error kind, the timeout, and a missing secret.
5. Add the provider to `examples/configs/all-providers.js` and a row to PROVIDERS.md marked
   untested live.

## Adding an extension

Policy, knowledge and receipt sinks follow the same pattern under `src/extensions/`. An extension
may only narrow what the relay does, and retrieved text must go through `cleanPassages`.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please do not open a public issue for a vulnerability.
