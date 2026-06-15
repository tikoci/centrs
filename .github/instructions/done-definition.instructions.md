---
applyTo: "src/**,test/**,commands/**,docs/MATRIX.md,docs/CONSTITUTION.md,AGENTS.md,**/AGENTS.md"
---

# Done definition

Read `docs/CONSTITUTION.md` before changing anything that touches RouterOS,
errors, settings, or the result envelope. Read `docs/MATRIX.md` to find the
cell you're working on. Read `commands/<name>/README.md` and
`commands/<name>/examples.md` for the executable spec.

## A feature is done when its CHR integration test is green

The **normative** done definition lives in
[`docs/CONSTITUTION.md` → Done definition](../../docs/CONSTITUTION.md#done-definition);
this section is the Copilot-workflow procedure for satisfying it.
"Coded" is not "done." "Unit-tested" is not "done." A cell in
`docs/MATRIX.md` advances to `CHR-passed` only when every example in
`commands/<name>/examples.md` passes against a real RouterOS CHR booted by
`@tikoci/quickchr`.

Before writing "done", "implemented", "complete", or advancing a MATRIX cell:

1. Run `bun run test:integration` and confirm it passes.
2. If no integration test covers the new behavior, add one in
   `test/integration/` that exercises the corresponding line(s) of
   `commands/<name>/examples.md`.
3. Record the CHR result (pass/fail, RouterOS version) in the commit message
   that advances the cell.

`bun run test` (unit only) is not sufficient. Unit tests cannot substitute for
CHR validation because RouterOS behavior cannot be reliably inferred from code
review alone.

## Validation is the product

Disabling validation to make a call work is forbidden. If the validator
rejects something a real router accepts, fix the validator with CHR evidence.
If a feature only passes its integration test with `validate=false`, the
feature is **not done** — it is broken.

The default is `validate=true`. `--validate=false` is an escape hatch for
probing undocumented edges, never a workaround for a centrs bug.

## When code and the constitution disagree

Fix the code. The constitution is short on purpose; if it's wrong, fix it
there first, then propagate. If a rule needs an exception, the exception goes
in the constitution — not scattered through commands.

## When examples.md and the test file disagree

The examples file is the executable spec; the test must exercise it. If they
drift:

- A line in `examples.md` not exercised by a test → the test file is wrong; add the test.
- A test that has no matching `examples.md` line → either add the line, or the
  test doesn't belong here.
- An example that only passes with `validate=false` → the implementation is
  wrong; do not edit the example.

## Adding integration tests

- Place tests under `test/integration/` with names matching the command:
  `rest-retrieve.test.ts`, `rest-execute.test.ts`, etc.
- Use `@tikoci/quickchr` to boot and tear down CHR — never hard-code IPs or
  assume a running router.
- Guard each test with `if (!process.env.CENTRS_RUN_FAST_INTEGRATION) return`.
  The `bun run test:integration` script sets the flag.
- A test that always passes without a real RouterOS round-trip provides no
  value. Each integration test must prove at least one real REST or API call
  succeeded.

## What not to do

- Do not add a new doc to capture status. `docs/MATRIX.md` is the only status
  surface.
- Do not add a new spec/work/roadmap directory. Per-command files in
  `commands/<name>/` are the local surface.
- Do not write prose explaining what code does; if the constitution and the
  per-command README cover the contract, additional prose is rot.
- Do not silently downgrade `--via`. If the requested protocol can't perform
  the operation, surface a `transport/*` error.
