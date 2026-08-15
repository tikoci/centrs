# Test Rules

- Unit tests are anchor tests for local behavior and exported contracts.
- Prefer RouterOS CHR integration tests through `quickchr` over complex mocks when behavior depends on RouterOS.
- Collect coverage for trend visibility, not as a percentage gate.
- Put long-running, RouterOS-backed, or platform-specific tests under `test/integration/` and wire them through QA or lab workflows. "Platform-specific" includes process-level tests that spawn the real `src/cli.ts` through `cli-process.ts` — including the **network-free** CLI smoke tier (`cli-smoke.test.ts`), which is not CHR-gated and so runs in the fast push/PR gate (`bun test`).
- Keep fixtures under `test/fixtures/` with clear source/provenance notes.

## Device-dependent expectations: declare the split, and prove it on long-term

RouterOS answers the same question differently across releases. An assertion
pinned to whatever the stable CHR happened to report goes red on the
`long-term` leg days later, on `main`, where it blocks the must-pass gate for
everyone (#297). Two rules, both cheap.

**1. Declare the split in `test/integration/chr.ts`, never inline.** A
version-dependent expectation belongs next to the contracts already there, so a
reviewer sees it in the diff and the next reader learns the split instead of
rediscovering it from a red gate:

| Contract | Use when |
| -------- | -------- |
| `routerOsAtLeast(version, target)` | the expectation changes at a known release |
| `VALIDATION_REJECT_CODES` | several codes are all correct answers |
| `TOBOOL_STRING_COERCED_SINCE` | an exact boundary — both sides booted, and adjacent |
| `PROPLIST_HIGHLIGHT_SPLIT_SINCE` | a *bracketed* boundary; say so in the header when the first affected build was never booted |
| `PARSE_REJECTED` / `PARSE_REJECTED_HINT` | device *wording* differs; keep the negative form wider than the positive |

Gate on the running version (`started.chr.state.version`), never on the channel
name — channels move. Prefer an accepted set over a version compare when both
answers are genuinely correct; reserve the compare for a real behaviour change.

Do not relax an assertion to make a version pass. Both sides stay exact: #296
kept a byte-exact highlight offset on every version, just not the same byte.

**2. Run the file you touched against `long-term` before calling it done.** The
default is stable, and a stable-only run cannot see any of this:

```sh
CENTRS_CHR_CHANNEL=long-term CENTRS_RUN_FAST_INTEGRATION=1 \
  bun test test/integration/<touched>.test.ts
```

Measured: ~22s for one file, 73–120s for two — against ~18 minutes for a full
CI leg. Every version-drift instance in #297 would have been caught by this
before the PR was opened.

This is prevention for *version drift*, not for flakes. A harness that mishandles
normal teardown (an unhandled socket error when a subprocess exits, #300) is a
different failure and only shows up by running the thing.
