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
- Work item `20260504C-name-resolution-and-discovery` to stage the still-open
  policy for discovery-backed names, cache freshness, and `centrs check`.

### Changed

- `S006`, `docs/ARCHITECTURE.md`, and `docs/WORKFLOW.md` now make the cautious
  alpha sequencing explicit: shared seams, harness confidence, and developer UX
  come before transport breadth.
- All current specs now use regularized YAML front matter for status,
  supersession, scope, and review source metadata.
- The alpha docs now reflect the clarified direction from the review answer pass:
  `retrieve` stays first, WinBox CDB participates in alpha resolution, REST is
  the first adapter but not the shared contract baseline, and timeout is a
  first-class cross-surface setting.
