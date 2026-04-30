# Status: initial design baseline

## Outcome

Strawman content split into specs S001–S005 plus `README.md`, `AGENTS.md`,
`docs/ARCHITECTURE.md`, and `docs/WORKFLOW.md`. Repository now lints, tests,
and builds cleanly with no implemented RouterOS behavior.

## Decisions captured

- One settings vocabulary across frontends (S004).
- Explicit `via` is required in alpha; no silent protocol fallback (S002, S004).
- MNDP is a hint source, not authoritative inventory (S003).
- Generated docs preferred over hand-maintained option tables (instruction:
  `generated-docs.instructions.md`).
- Spec lifecycle metadata required on every spec (S005).

## Instruction gaps found

- The initial design did not ground the full protocol map or pick a first alpha
  transport, credential source, validation source, or device source. Captured in
  `S006-alpha-first-command.md` (Draft) so future agents have a parking spot
  instead of re-litigating in every PR.

## Links

- `GOAL.md` — original grounding.
- `PLAN.md` — what was done and what is next.
- Specs S001–S006.
