# Roadmap

Single source of truth for feature status and what to work on next.

**"Done" requires a passing integration test against CHR** — not just code existing. See `test/AGENTS.md` and `docs/WORKFLOW.md` for test tiers. Run `bun run test:integration` to advance a feature from `coded` to `smoke-passed`.

## Status key

| Label | Meaning |
| --- | --- |
| `idea` | Referenced or described; no code |
| `specced` | Has an Accepted governing spec |
| `coded` | Implementation exists; not yet CHR-tested |
| `smoke-passed` | Basic CHR round-trip verified by integration test |
| `integration-tested` | Full integration test suite passing in CI |

## Feature status

| Feature | Status | Governing spec | Notes |
| --- | --- | --- | --- |
| CLI settings and precedence | `coded` | S004 (Accepted) | Unit-tested; CHR interaction not yet validated |
| Structured errors (shape) | `coded` | S007 (Draft) | Error shapes exist; error code `transport/connection-refused` maps to `transport/network` on unreachable host — integration test exposes this |
| `retrieve` via REST | `smoke-passed` | S006 (Draft) | `/system/resource` retrieves successfully (validate=false). Default `validate=true` broken — `/console/inspect` path format untested. See open questions. |
| `retrieve` integration test | `smoke-passed` | S008 (Draft) | `test/integration/rest-retrieve.test.ts` runs against CHR; 1/2 tests pass. Failing test: unreachable host error code mismatch |
| CDB device lookup | `coded` | S003 (Accepted) | Lookup code exists; not tested end-to-end |
| `execute` via REST | `idea` | — | Not started |
| `update` via REST | `idea` | — | Not started |
| `devices` command | `idea` | — | Not started |
| CDB groups | `idea` | S003 (Accepted) | Not started |
| Native API transport | `idea` | S002 (Accepted) | Not started |
| SSH transport | `idea` | S002 (Accepted) | Not started |
| API programmatic use | `specced` | S001 (Accepted) | Exports exist; no external usage test |
| MCP server | `idea` | — | Future target; guides interface-shape decisions |
| TUI | `idea` | — | Future target |
| Proxy | `idea` | — | Future target |

## What's next

Ordered by priority. Do not begin a later item unless earlier `coded` items have reached `smoke-passed`.

1. **Fix error code mismatch in unreachable-host path** — integration test shows `transport/network` is returned instead of `transport/connection-refused` when the host is down. Trace through `src/errors.ts` and the REST fetch error handler to find where the code is assigned. Fix must be validated with `bun run test:integration`.

2. **Fix `--validate` default / `/console/inspect` path** — `retrieve /ip/address` and `retrieve /system/resource` both fail with `[routeros/unsupported-path]` when `validate=true` (the default). Either fix the path format in `inspectAttributes()` (`src/retrieve.ts`) with CHR evidence, or temporarily change the default to `false`. CHR evidence required before re-enabling.

3. **S006 → Accepted** — the open questions in S006 are answered in `.scratch/readme-answers-nextsteps.md`. Promote those answers into S006, accept the spec, and remove the "grounding gate" language.

4. **S007 → Accepted** — run error-contract tests (bad auth, timeout, bad path) against a CHR and accept the structured errors spec.

5. **S008 → Accepted** — wire the `@tikoci/quickchr` harness into the default CI push trigger and accept the test-harness spec.

6. **`execute` command** — first REST implementation, following the same pattern as `retrieve`. Must include an integration test before marking done.

7. **CDB groups** — extend CDB lookup to support group targets per S003.

8. **API usability** — external usage example and test; confirm `index.ts` exports are ergonomic for consumers.

## Open questions (unblocking decisions needed)

| Question | Context | Blocking |
| --- | --- | --- |
| Should `--validate` default to `false`? | Current `true` default breaks all retrieve calls until `/console/inspect` is fixed | Items 1–2 above |
| What format does REST `/console/inspect` expect for path? | `pathToInspectString` joins with commas: `ip,address` — needs CHR test to confirm | Item 1 |
| When should S006 be closed vs. kept as "parking lot"? | S006 conflates accepted decisions with open research; splitting may help agents | Item 3 |
