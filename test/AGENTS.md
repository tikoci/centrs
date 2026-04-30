# Test Rules

- Unit tests are anchor tests for local behavior and exported contracts.
- Prefer RouterOS CHR integration tests through `quickchr` over complex mocks when behavior depends on RouterOS.
- Collect coverage for trend visibility, not as a percentage gate.
- Put long-running, RouterOS-backed, or platform-specific tests under `test/integration/` and wire them through QA or lab workflows.
- Keep fixtures under `test/fixtures/` with clear source/provenance notes.
