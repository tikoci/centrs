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

## Realized in

The policy above maps to five workflows (quickchr's `ci`/`publish`/`verify-extended`
scheme as the reference):

- **Push/PR gate** → `ci.yaml`: lint ‖ unit+coverage → **stable CHR smoke**
  (`test/integration/chr-smoke.test.ts`, single boot) → cross-platform unit
  (macOS gates; Windows informational). Coverage + failing tests surface to the
  job summary + artifacts; coverage floor is a non-blocking annotation.
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
- **Release/publish** → `release.yaml`: `v*` tag or dispatch(dry-run); even/odd
  minor → npm `next`/`latest`; release-tier sweep via `qa.yaml` `workflow_call`
  (all channels); `--provenance`; needs `NPM_TOKEN`.
- **Extended platforms** → `verify-extended.yaml` (dispatch): macOS-x86 (HVF) +
  Windows-x86 (TCG, informational). A `packages` input installs extra RouterOS
  packages into the CHR (e.g. `container`) for a fuller-RouterOS run.

Deviations from the strict tiers, by design: cross-platform **unit** runs on the
gate (not a separate pre-release trigger); macOS/Windows **integration** is the
dispatch-only `verify-extended` sweep. `startIntegrationChr` now takes arch +
packages from quickchr (`CENTRS_CHR_ARCH`, `CENTRS_CHR_PACKAGES`), so the
centrs side is ready; what stays deferred is the **arm64 job** — quickchr 0.4.2
has an arm64 REST-POST bug (returns the prior GET's body; quickchr BACKLOG P3)
that breaks centrs's execute path, so an arm64 job would be known-red until that
upstream fix lands — and wiring the **release-tier** extra-packages through
`qa.yaml`, folded into the release re-review.
