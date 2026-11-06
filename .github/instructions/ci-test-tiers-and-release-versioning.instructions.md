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

- **On every code PR and push to main** — unit tests on Linux, macOS and
  Windows + a *smoke* integration tier on quickchr (does the CLI/API generally
  work: core paths, common commands). Stable channel only, x86 Linux runner.
  A **docs-only** change runs the repo checks (`lint:ci`) only.
- **Nightly** — the definitive QA run: every active RouterOS channel on CHR,
  only when main's HEAD or a resolved channel version changed since the last
  completed nightly. While the latest nightly sweep is red on a must-pass
  channel, ordinary PRs cannot merge; a `fixes-main` PR can.
- **On publish** (`@next` or `@latest`) — the published commit must have a green
  QA run. The release reuses a nightly sweep on that commit, waits if one is
  still running, and sweeps itself when no nightly swept it. Richer quickchr options at release (extra
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

- **Push/PR gate** → `ci.yaml`. A `changes` job (`scripts/ci-changes.ts`)
  classifies the diff. Repo checks (`lint:ci`) always run; unit, build, corpus
  census and stable CHR smoke skip on a **docs-only** change through a
  job-level `if:`, never a workflow-level `paths:` (a required check that never
  reports stays pending; a job skipped by `if:` reports success). Docs-only is
  conservative: prose no test, script or build reads — not
  `commands/*/examples.md`, generated docs, or prose a test parses
  (`test/unit/ci-changes.test.ts` guards the list). A PR is docs-only when its
  whole diff is; a push to main when its own diff is. Unit runs
  on Linux (with coverage) and macOS + Windows (Windows informational); the
  required check `Unit tests & coverage` aggregates them. Repo checks then
  unlock the build, while repo checks + Linux unit unlock **stable CHR smoke**
  (`test/integration/chr-smoke.test.ts`, single boot). On PRs, `Main health
  (nightly QA)` fails while the latest nightly sweep failed on a must-pass
  channel, unless the PR carries the `fixes-main` label (read live: add it,
  then re-run the job). Coverage + failing tests surface to the job summary +
  artifacts; coverage floor is a non-blocking annotation. The local pre-push
  hook runs the same `lint:ci` repo checks but leaves unit tests and build to
  these hosted jobs.
- **Definitive channel matrix** → `qa.yaml`: nightly + dispatch +
  `workflow_call`, no push trigger. The `resolve-matrix` job is also the
  nightly pre-flight (`scripts/qa-nightly.ts preflight`): it sweeps only when
  main's HEAD or a resolved channel version differs from
  `nightly-fingerprint.json` on the `qa-history` branch, which the sweeping
  nightly writes. A dispatch applies the pre-flight with `if-changed=true`; a
  release sweep never does. A skipped night ends `success` having booted
  nothing, so its readers (release plan, main health) inspect jobs, not the run
  conclusion. The active set is **recency-aware**, resolved via quickchr
  (`resolveAllVersions` / `selectActiveChannels`, suffix-aware
  `compareRouterOsVersion`) — released channels (stable, long-term) always,
  plus any pre-release (testing, development) *at or ahead of stable*, since
  the four channels are not monotonically ordered. Only the **released**
  channels are must-pass — pre-release legs are best-effort (a beta
  btest/EC-SRP5 flake records to history but never reds the run). A concrete
  channel / `routeros_version` on dispatch pins a single leg; `all` / schedule /
  the release sweep fan the active set. Every run has its own concurrency
  group. Per-run `bun:sqlite` store, plus an `accumulate-and-gate` job that
  appends every run to a durable append-log on the `qa-history` branch and
  fails only on a released-channel regression. Boundary: quickchr owns "what's
  worth booting" (recency); centrs owns "what must pass" — the gate is defined
  once in `scripts/qa-results-db.ts` (`channelPolicy` /
  `evaluateMustPassGate`), the matrix axis in `scripts/qa-active-channels.ts`,
  the accumulator in `scripts/qa-history.ts`, the pre-flight and main health in
  `scripts/qa-nightly.ts`.
- **Security/quality** → `codeql.yaml` (PR + push + weekly + dispatch): CodeQL
  plus zizmor. After editing a workflow, run `bun run lint:actions` (zizmor,
  needs `uv`; not in `lint:ci`). Action refs are tags, never SHAs; `setup-bun`
  reads `bun-version-file: package.json`; checkouts set
  `persist-credentials: false` unless the job pushes (SECURITY.md, #266).
- **Release/publish** → `release.yaml`: dispatch-only from `main` (a pushed
  `v*` tag triggers nothing). `channel=next` → `<base>-next.<run_number>` on
  npm `next`; `channel=latest` → the committed version on `latest`, `next`
  moved forward, tag + GitHub Release. Lint/unit/build on the commit, then a
  nightly sweep on that commit is reused; `qa.yaml` is called through
  `workflow_call` when no nightly swept it (none yet, a skipped night, or only
  cancelled runs). `--provenance`; needs `NPM_TOKEN`.
- **Extended platforms** → `verify-extended.yaml` (dispatch): macOS-x86 (HVF) +
  Windows-x86 (TCG, informational). A `packages` input installs extra RouterOS
  packages into the CHR (e.g. `container`) for a fuller-RouterOS run.

Deviations from the strict tiers, by design: the channel sweep is nightly, not
per push, so a regression on main surfaces within a day and then blocks
ordinary merges through main health; macOS/Windows **integration** is the
dispatch-only `verify-extended` sweep. `startIntegrationChr` now takes arch +
packages from quickchr (`CENTRS_CHR_ARCH`, `CENTRS_CHR_PACKAGES`), so the
centrs side is ready; what stays deferred is the **arm64 job** — quickchr 0.4.2
has an arm64 REST-POST bug (returns the prior GET's body; quickchr BACKLOG P3)
that breaks centrs's execute path, so an arm64 job would be known-red until that
upstream fix lands — and wiring extra packages into the release gate (#97).
