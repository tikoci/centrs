# Goal: quickchr harness

## Problem

`centrs` says RouterOS-backed behavior should be tested against real CHR
instances, and the repository already depends on `@tikoci/quickchr`, but there
is no boot helper, version matrix, or CI tier policy yet. The current REST
integration test is still skipped.

This work item stages the harness shape before transport work relies on ad hoc
tests or mock-shaped assumptions.

## Scope

- Define the CHR boot/teardown helper shape for integration tests.
- Define fast versus deep harness tiers and how they should be triggered.
- Define the representative RouterOS version-matrix policy.
- Stage an error-contract test pattern that future transports must satisfy.
- Feed stable outcomes into `S008`, `S006`, QA workflow updates, and future
  transport work.

## Non-goals

- Implement the REST transport itself.
- Require a full version matrix on every push.
- Replace unit tests with CHR-backed tests.

## Source material

- External review inventory captured on 2026-05-04.
- `docs/specs/S006-alpha-first-command.md`
- `docs/specs/S008-quickchr-harness-and-version-policy.md`
- `test/AGENTS.md`
- `test/integration/rest-retrieve.test.ts`
- `package.json`
