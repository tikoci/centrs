---
applyTo: ".github/workflows/*.yaml,.github/workflows/*.yml,package.json,CHANGELOG.md"
---

# CI test tiers and release versioning

How much testing runs when, and how versions signal pre-release vs release.
This is policy; `docs/CONSTITUTION.md` (Done definition) still governs what
"done" means for a single feature — a live capability's CHR integration test
green via `@tikoci/quickchr`, or an offline capability's baseline acceptance
criteria in its command README.

## Test tiers

Integration tests do **not** run on every commit; they must still run and pass,
with "levels" controlling depth (how many RouterOS versions, repeats). Always
align on `@tikoci/quickchr` for bringing up RouterOS; if it needs a tweak, flag
it upstream rather than working around it.

- **On push** — unit tests + a *smoke* integration tier on quickchr (does the
  CLI/API generally work: core paths, common commands). Stable channel only,
  x86 Linux runner.
- **On push to main** — the definitive QA run: every active RouterOS channel
  on CHR, plus unit tests on macOS and Windows.
- **On publish** (`@next` or `@latest`) — the published commit must have a green
  QA run. The release reuses main's push or scheduled run on that commit, waits
  if one is still running, and sweeps only when there is none or every one was
  cancelled. Richer quickchr options at release (extra
  packages such as `container`, arm64) are not wired yet (#97).
- CI must be runnable **separately from the release process**, so agents can fix
  bugs or improve CI without triggering an actual publish (`workflow_dispatch`
  with a version input is the pattern; a deep "all versions" sweep can be its own
  `workflow_dispatch` or scheduled workflow).
- Structure CI output to be **agent-friendly**: a failed run should let an agent
  find the failing test/data without ingesting the whole build log (e.g. surface
  the one failing test, not the full output).

## Release versioning

Standard npm semantics: the **SemVer pre-release identifier** selects the
dist-tag. **Both publish to NPM**, from one button on `main` (#484):

```sh
gh workflow run release.yaml                     # @next
gh workflow run release.yaml -f channel=latest   # stable
gh workflow run release.yaml -f dry-run=true     # gates checked, CHR gate reported, nothing published
```

- **`@next`** publishes `<base>-next.<run_number>` (`0.1.9-next.23`) to npm tag
  `next`. It needs no commit, PR, git tag or GitHub Release: the version is
  written into `package.json` inside the runner only, and provenance records the
  commit. Cut one whenever main is worth trying.
- **`@latest`** publishes the committed plain version (`0.1.9`), moves `next`
  to it so `@next` never resolves older than `@latest`, and creates tag
  `v0.1.9` with a GitHub Release whose notes are the CHANGELOG section.
- The release publishes the commit the dispatch ran on, never an older green
  one, because npm provenance attests `GITHUB_SHA`.

`package.json` on main holds the version the work is heading to with a `-next`
suffix (`0.1.9-next`); `<base>` is that version without the suffix. A plain
version that already shipped makes `<base>` the following patch, so a `@next`
cut never waits on a bump commit.

`CHANGELOG.md` has **one section per stable version** (#485). Work in progress
goes under `## 0.1.9 — next`; a `-next.N` build gets no section of its own.
Cutting stable: one commit that sets `package.json` to `0.1.9` and the heading
to `## 0.1.9 — YYYY-MM-DD`, then the `latest` dispatch once that commit's QA is
green. The first change after a stable cut adds `## 0.1.10 — next` and sets
`package.json` to `0.1.10-next`.

The even/odd **minor** rule is gone: pre-release status lives in the version
string, where npm, `npm outdated` and range resolvers can all see it.
`scripts/release-plan.ts` holds every release decision (version, gates, CHR
reuse) and is unit-tested; the workflow only calls it.

## Realized in

The policy above maps to five workflows (quickchr's `ci`/`publish`/`verify-extended`
scheme as the reference):

- **Push/PR gate** → `ci.yaml`: `lint:ci` repo checks ‖ unit+coverage; repo
  checks then unlock the build, while repo checks + unit green unlock
  **stable CHR smoke**
  (`test/integration/chr-smoke.test.ts`, single boot). `lint:ci` runs once; its
  source-lint subset is not repeated as a separate step. Coverage + failing
  tests surface to the job summary + artifacts; coverage floor is a non-blocking
  annotation. Cross-platform unit (macOS + Windows) runs in `qa.yaml` on push to
  main, not here — keeping PR runs fast. The local pre-push hook runs the same
  `lint:ci` repo checks but leaves unit tests and build to these required,
  parallel hosted jobs.
- **Definitive channel matrix** → `qa.yaml`: push[main] + weekly + dispatch +
  `workflow_call`. The active set is **recency-aware**, resolved per run by the
  `resolve-matrix` pre-flight job via quickchr (`resolveAllVersions` /
  `selectActiveChannels`, suffix-aware `compareRouterOsVersion`) — released
  channels (stable, long-term) always, plus any pre-release (testing, development)
  *at or ahead of stable*, since the four channels are not monotonically ordered.
  Only the **released** channels are must-pass — pre-release legs are best-effort
  (a beta btest/EC-SRP5 flake records to history but never reds the run). A
  concrete channel / `routeros_version` on dispatch pins a single leg; `all` /
  push / schedule / the release sweep fan the active set. Event-aware concurrency
  (cancel on main-push; independent dispatch). Per-run `bun:sqlite` store, plus an
  `accumulate-and-gate` job that appends every run to a durable append-log on the
  `qa-history` branch and fails only on a released-channel regression. Boundary:
  quickchr owns "what's worth booting" (recency); centrs owns "what must pass" —
  the gate is defined once in `scripts/qa-results-db.ts` (`channelPolicy` /
  `evaluateMustPassGate`), the matrix axis in `scripts/qa-active-channels.ts`, the
  accumulator in `scripts/qa-history.ts`.
- **Security/quality** → `codeql.yaml` (PR + push + weekly + dispatch) + the
  AI-findings probe.
- **Release/publish** → `release.yaml`: dispatch-only from `main` (a pushed
  `v*` tag triggers nothing). `channel=next` → `<base>-next.<run_number>` on
  npm `next`; `channel=latest` → the committed version on `latest`, `next`
  moved forward, tag + GitHub Release. Lint/unit/build on the commit, then
  main's QA on that commit is reused; `qa.yaml` is called through
  `workflow_call` only when there is no push/scheduled run there or every one
  was cancelled. `--provenance`;
  needs `NPM_TOKEN`.
- **Extended platforms** → `verify-extended.yaml` (dispatch): macOS-x86 (HVF) +
  Windows-x86 (TCG, informational). A `packages` input installs extra RouterOS
  packages into the CHR (e.g. `container`) for a fuller-RouterOS run.

Deviations from the strict tiers, by design: cross-platform **unit** runs in
`qa.yaml` on push to main (not on every PR, and not a separate pre-release
trigger — QA catches escapes before they compound); macOS/Windows
**integration** is the dispatch-only `verify-extended` sweep. `startIntegrationChr` now takes arch +
packages from quickchr (`CENTRS_CHR_ARCH`, `CENTRS_CHR_PACKAGES`), so the
centrs side is ready; what stays deferred is the **arm64 job** — quickchr 0.4.2
has an arm64 REST-POST bug (returns the prior GET's body; quickchr BACKLOG P3)
that breaks centrs's execute path, so an arm64 job would be known-red until that
upstream fix lands — and wiring extra packages into the release gate (#97).
