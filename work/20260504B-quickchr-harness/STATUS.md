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
- Prefer a clean base CHR for the default smoke path. Extra packages, disks,
  users, device-mode changes, or non-free licensing belong in opt-in deeper
  suites.

## Working answers from the 2026-05-04 answer pass

1. The default harness should boot a mostly clean base CHR and rely on the free
   license unless a deeper suite explicitly needs more.
2. The main smoke path should follow stable-channel RouterOS. Deeper
   release-readiness runs should cover all four release channels, and
   `workflow_dispatch` should be able to pin one specific version directly.
3. Push/default CI should run unit tests plus a basic CHR smoke suite on x86
   Linux. Wider platform coverage and more specialized CHR setups belong in
   pre-release or deeper release-readiness runs.
4. Test execution should be separable from the publication workflow so CI and
   harness work can evolve without pretending every run is a release.
5. CI output should be structured for agent readability, with concise failure
   summaries and minimal log-hunting.
