# Changelog

All notable changes to this repository should be recorded here.

`centrs` is still pre-alpha, so early entries may describe shifts in staged
specs, workflow, or contributor expectations before they describe a broad user
surface. Keep version bumps and release notes aligned once the first real
transport lands.

## Unreleased

### Added

- A clearer implementation snapshot in `README.md` so the documented surface does
  not imply more runnable behavior than the repository currently has.
- Draft spec `S007` for structured errors and bug-report contracts.
- Draft spec `S008` for `quickchr`-backed harness tiers and RouterOS version
  policy.
- Work items `20260504A-typed-core-seams` and `20260504B-quickchr-harness` to
  stage the missing shared seams and test-harness work before transport growth.

### Changed

- `S006`, `docs/ARCHITECTURE.md`, and `docs/WORKFLOW.md` now make the cautious
  alpha sequencing explicit: shared seams, harness confidence, and developer UX
  come before transport breadth.
