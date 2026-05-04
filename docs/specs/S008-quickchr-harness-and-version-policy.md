# S008: quickchr Harness and Version Policy

## Status

Draft.

Metadata:

- Supersedes: none
- Superseded by: none
- Scope: extends S006
- Review source: `work/20260504B-quickchr-harness/`

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
- Early smoke targets should exercise shared seams, not just one transport:
  `centrs check` for target/settings/error UX and the first `centrs retrieve`
  command for the first real RouterOS round-trip.
- Transport work is not complete until canonical failure modes produce the shared
  structured error contract from S007.

## Test tiers

The exact workflow wiring can evolve, but the project should maintain these
distinct tiers:

| Tier | Purpose | Expected trigger |
| --- | --- | --- |
| `unit` | Local regression guardrails for parsers, resolvers, metadata, and typed contracts without booting RouterOS. | Default `bun test` |
| `fast-integration` | One pinned CHR version plus smoke tests for the current alpha command loop and shared seam behavior. | Explicit local run and selective CI job |
| `deep-matrix` | Version-coverage pass across representative long-term/stable/beta releases. | `workflow_dispatch`, scheduled QA, or dedicated release-readiness runs |
| `error-contract` | Canonical failure checks proving each transport emits the shared structured error shape for DNS/refused/timeout/auth/version/capability failures. | Whenever a transport or the error contract changes |

## Version policy

The deep matrix should cover representative releases instead of one arbitrary
RouterOS image:

- one long-term anchor,
- one current stable anchor,
- one current beta/testing anchor when available.

The exact pinned versions belong in harness configuration or workflow inputs so
they can be updated without rewriting every test.

## Workflow expectations

- Unit tests remain the cheap default.
- Fast and deep CHR-backed tiers should be easy to invoke locally and in CI, but
  they do not need to run on every push or before every commit.
- The QA workflow should be able to run a narrower fast tier for targeted review
  and a wider deep tier for explicit deeper validation.
- Failure reports from harness runs should preserve enough structured context to
  become useful bug reports rather than one-off console text.

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
