---
status: Draft
supersedes: none
superseded_by: none
scope: extends S006
review_source: work/20260504B-quickchr-harness/
---

# S008: quickchr Harness and Version Policy

## Context

`centrs` already depends on `@tikoci/quickchr`, but no CHR boot helper, test
tier policy, or RouterOS version matrix is wired yet. The current REST
integration test is still skipped. Because RouterOS and WinBox docs are limited,
unit tests alone are not enough for transport confidence.

This spec stages the harness and version-policy work before transport
implementation grows beyond one small slice.

## Requirements

- RouterOS behavior that matters for correctness should be validated against real
  CHR instances via `quickchr`, not approximated with elaborate mocks.
- If `quickchr` needs features or fixes for `centrs`, that dependency work should
  be surfaced explicitly rather than silently weakening the test strategy.
- Integration tiers should exist so the project can choose depth without forcing
  full matrix runs on every edit or push.
- Harness configuration should pin concrete RouterOS versions in one place rather
  than scattering version numbers across individual tests.
- The default harness image should stay as close to a clean base CHR as
  practical. Extra packages, disks, users, licenses, or device-mode changes
  belong in opt-in deeper suites rather than the basic smoke path.
- Early smoke targets should exercise shared seams, not just one transport:
  the first `centrs retrieve` command for the first real RouterOS round-trip,
  plus the shared target/settings/error contracts behind it.
- Transport work is not complete until canonical failure modes produce the shared
  structured error contract from S007.

## Test tiers

The exact workflow wiring can evolve, but the project should maintain these
distinct tiers:

| Tier | Purpose | Expected trigger |
| --- | --- | --- |
| `unit` | Local regression guardrails for parsers, resolvers, metadata, and typed contracts without booting RouterOS. | Default `bun test` |
| `fast-integration` | One clean stable-channel CHR plus smoke tests for the current alpha command loop and shared seam behavior. | Explicit local run and default push/PR CI |
| `deep-matrix` | Cross-channel or pinned-version coverage beyond the default stable smoke suite. | `workflow_dispatch`, scheduled QA, or dedicated release-readiness runs |
| `error-contract` | Canonical failure checks proving each transport emits the shared structured error shape for DNS/refused/timeout/auth/version/capability failures. | Whenever a transport or the error contract changes |

## Version policy

The main smoke path should follow the current stable channel. Deeper runs should
be able to cover the current RouterOS release channels that matter for public
confidence:

- long-term,
- stable,
- testing,
- development.

Workflow-dispatched runs should also be able to pin one specific RouterOS
version directly so the project can reproduce or investigate version-specific
failures without rewriting tests.

## Workflow expectations

- Unit tests remain the cheap default.
- Push/default CI should run unit tests plus a basic stable-channel CHR smoke
  suite on an x86 Linux runner.
- Pre-release validation can widen platform coverage for the same basic smoke
  suite without forcing the full channel matrix every time.
- Release-readiness validation should be able to widen both channel coverage and
  harness sophistication, including opt-in suites that need extra packages or
  other `quickchr` options.
- Fast and deep CHR-backed tiers should be easy to invoke locally and in CI, but
  they do not need to run before every commit.
- Test workflows should be decoupled from the publication workflow so the team
  can iterate on CI or rerun deeper validation without pretending every run is a
  release attempt.
- Failure reports from harness runs should preserve enough structured context to
  become useful bug reports rather than one-off console text.
- CI output should be agent-friendly: concise per-test failure summaries, easy
  links to the failing job, and enough structured context that an agent fixing a
  broken build does not need to ingest an entire log stream first.

## Out of scope for this Draft

- Finalizing the CI workflow file wiring.
- Selecting the exact first stable/long-term/beta version numbers.
- Implementing the REST adapter itself.

## Open questions

- Should local macOS harness runs and Linux CI share one boot helper or only one
  configuration format?
- Which canonical failures should use live CHR scenarios versus local fault
  injection around a real adapter?
- When the first transport lands, should `fast-integration` stay opt-in on pull
  requests or become part of a narrower protected gate?
