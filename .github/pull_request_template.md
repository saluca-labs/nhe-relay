## What changed

## How it was tested
- [ ] `npm run check`, `npm run mutants`, `npm run lint:text` and `npm run deploy:dry` pass locally.
- [ ] New behaviour has a test that failed before the change (say how you saw it fail).
- [ ] CI is green, including `gate / Merge gate all`.

## Review
- [ ] Every new or changed capability claim in the docs has a CLAIMS.md row, and the wording matches what the code does.
- [ ] No limit, ceiling or guard is loosened; configuration still only narrows.
- [ ] A new provider or extension is marked "untested live" in PROVIDERS.md unless a live run is recorded.
- [ ] No keys, local paths or private hostnames.
