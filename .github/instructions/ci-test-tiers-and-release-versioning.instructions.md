---
applyTo: ".github/workflows/*.yaml,.github/workflows/*.yml,package.json,CHANGELOG.md"
---

# CI test tiers and release versioning

How much testing runs when, and how versions signal pre-release vs release.
This is policy; `docs/CONSTITUTION.md` (Done definition) still governs what
"done" means for a single feature (its CHR integration test green via
`@tikoci/quickchr`).

## Test tiers

Integration tests do **not** run on every commit; they must still run and pass,
with "levels" controlling depth (how many RouterOS versions, repeats). Always
align on `@tikoci/quickchr` for bringing up RouterOS; if it needs a tweak, flag
it upstream rather than working around it.

- **On push** — unit tests + a *smoke* integration tier on quickchr (does the
  CLI/API generally work: core paths, common commands). Stable channel only,
  x86 Linux runner.
- **On pre-release** — same workflow as push, **also** on macOS and Windows
  runners.
- **On release** — more sophisticated tests with richer quickchr options (extra
  packages, e.g. `container`); exercise all four RouterOS release channels.
- CI must be runnable **separately from the release process**, so agents can fix
  bugs or improve CI without triggering an actual publish (`workflow_dispatch`
  with a version input is the pattern; a deep "all versions" sweep can be its own
  `workflow_dispatch` or scheduled workflow).
- Structure CI output to be **agent-friendly**: a failed run should let an agent
  find the failing test/data without ingesting the whole build log (e.g. surface
  the one failing test, not the full output).

## Release versioning

Even/odd **minor** signals channel; **both publish to NPM**:

- Odd minor = **pre-release** (e.g. `0.1.x`).
- Even minor = **release** (e.g. `0.2.x`).

Keep `CHANGELOG.md` current with the bump.
