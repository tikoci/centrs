---
applyTo: "src/**,test/**,AGENTS.md,docs/WORKFLOW.md"
---

# Integration testing mandate

## "Done" definition for transport code

**"Coded" is not "done."** Transport-touching code is complete only when an integration test against a real CHR passes.

Before writing "implemented", "done", "complete", or closing a work item for any change in `src/retrieve.ts`, `src/protocols/`, `src/execute.ts`, or other transport code:

1. Run `bun run test:integration` and confirm it passes.
2. If no integration test covers the new behavior, write one in `test/integration/` first.
3. Record the CHR result (pass/fail, RouterOS version) in the relevant work item `STATUS.md`.

`bun run test` (unit tests only) is not sufficient. Unit tests cannot substitute for CHR validation because RouterOS behavior cannot be reliably inferred from code review alone.

## Running integration tests

```bash
# Run the integration suite against a local CHR (always required before "done")
bun run test:integration

# quickchr manages CHR lifecycle automatically; no manual setup required on macOS
```

`CENTRS_RUN_FAST_INTEGRATION=1` controls whether integration tests run. The `test:integration` script sets it automatically. Do not skip this step.

## Test tiers (from S008)

| Tier | Script | When required |
| --- | --- | --- |
| `unit` | `bun run test` | All changes |
| `fast-integration` | `bun run test:integration` | Any transport or CLI change |
| `deep-matrix` | manual or scheduled | Cross-version or release coverage |
| `error-contract` | `bun run test:integration` (subset) | Transport or error-shape changes |

## Adding integration tests

- Place tests under `test/integration/` with a name matching the feature (`rest-retrieve.test.ts`, `rest-execute.test.ts`).
- Use `@tikoci/quickchr` to boot and tear down the CHR — do not hard-code IP addresses or assume a running router.
- Guard the test with `if (!process.env.CENTRS_RUN_FAST_INTEGRATION) { ... }` for the same pattern already used in existing tests. The `bun run test:integration` script handles the flag.
- A test that always passes (no actual RouterOS round-trip) provides no value. Each integration test must prove at least one real REST or API call succeeded.

## Feature status

`docs/ROADMAP.md` tracks the actual test state (idea / coded / smoke-passed / integration-tested) for every feature. Update it when a feature moves to `smoke-passed` or `integration-tested`.
