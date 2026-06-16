# Test Rules

- Unit tests are anchor tests for local behavior and exported contracts.
- Prefer RouterOS CHR integration tests through `quickchr` over complex mocks when behavior depends on RouterOS.
- Collect coverage for trend visibility, not as a percentage gate.
- Put long-running, RouterOS-backed, or platform-specific tests under `test/integration/` and wire them through QA or lab workflows. "Platform-specific" includes process-level tests that spawn the real `src/cli.ts` through `cli-process.ts` — including the **network-free** CLI smoke tier (`cli-smoke.test.ts`), which is not CHR-gated and so runs in the fast push/PR gate (`bun test`).
- Keep fixtures under `test/fixtures/` with clear source/provenance notes.
