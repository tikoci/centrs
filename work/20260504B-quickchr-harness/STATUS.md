# Status: quickchr harness

## Current state

- `@tikoci/quickchr` is already a dev dependency.
- `test/AGENTS.md` already points transport-sensitive tests toward real CHR.
- `test/integration/rest-retrieve.test.ts` is still a skipped placeholder with no
  boot helper or harness wiring.
- No RouterOS version-matrix policy or CI tier policy is written yet.

## Harness posture

- Keep unit tests cheap and local by default.
- Make CHR-backed integration runs easy to invoke locally and in CI without
  forcing them on every push or before every commit.
- Treat `quickchr` as the default RouterOS harness. If it needs changes, surface
  that as dependency work instead of weakening the test shape.
- Use the harness to validate both happy-path command behavior and canonical
  structured error behavior.

## Next decisions

1. What exact boot helper shape should `test/integration/chr.ts` expose?
2. Which pinned long-term, stable, and beta versions should the deep matrix
   start with?
3. Which fast-tier jobs should be available on pull requests versus
   `workflow_dispatch` and scheduled QA?
