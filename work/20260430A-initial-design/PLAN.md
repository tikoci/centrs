# Plan: initial design baseline

This is the execution view for the original strawman work. The grounding lives
in `GOAL.md`; the durable outcomes live in S001–S005 and `docs/ARCHITECTURE.md`.

## Done

- Promoted strawman intent into specs S001–S005.
- Established `.github/instructions/*.instructions.md` scoped rules.
- Wired CI, QA (CodeQL + dependency review), Lab, Pages, and Release placeholder workflows.
- Wired pre-commit and pre-push hooks via `package.json` scripts.
- Converted protocol placeholder files into a typed protocol registry.
- Added skipped CHR integration-test placeholder for the eventual first REST
  retrieve slice.

## In progress

- Resolve protocol-grounding requirements and alpha defaults in
  `docs/specs/S006-alpha-first-command.md`.

## Next

- Open `work/<date>-protocol-grounding/` to build the matrix required by S006.
- Move S006 from `Draft` to `Accepted` after protocol grounding and alpha
  defaults are locked.
- Open `work/<date>-alpha-rest-retrieve/` for the first transport
  implementation only after S006 is accepted.
