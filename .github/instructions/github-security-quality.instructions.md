---
applyTo: "SECURITY.md,.github/workflows/codeql.yaml,.github/workflows/qa.yaml,.github/codeql-config.yml,.github/dependabot.yaml,src/**,package.json,bun.lock"
---

# GitHub security and quality scanning

Use `SECURITY.md` as the source-of-truth summary for scanning posture.

- Keep CodeQL configured with the `security-and-quality` suite for public tikoci repos unless a spec says otherwise.
- Treat the GitHub Security tab as the live alert state and aim for 0 open findings.
- AI findings are noisy; address each finding on its merits or dismiss false positives in the GitHub UI (or `gh api .../code-scanning/alerts/{n} -X PATCH`) with a written justification. There is no in-code suppression comment CodeQL honors (`// lgtm[...]` and similar are not read by GitHub's scanner) — dismissal (with reason + comment, ≤280 chars) or a `codeql-config.yml` query-filter are the only native mechanisms.
- The PR-blocking "CodeQL" check is GitHub's alert-diff gate, distinct from the `Analyze (*)` workflow jobs. It compares alerts on `refs/pull/<n>/merge` against the base branch; inspect it with `gh api "/repos/<owner>/<repo>/code-scanning/alerts?ref=refs/pull/<n>/merge"` (the default, no-`ref` query only returns default-branch alerts and will look empty on an open PR).
- To see *why* an alert fired, download the SARIF for the PR's analysis (`gh api -H "Accept: application/sarif+json" /repos/.../code-scanning/analyses/<analysis_id>`, id from `gh api ".../code-scanning/analyses?ref=refs/pull/<n>/merge"`) and read `results[].codeFlows` — the REST alert endpoints do not expose the taint path, only the final message.

## Two recurring false-positive shapes in this repo

Both are confirmed against the actual query sources in `github/codeql` (`javascript/ql/lib/semmle/javascript/security/dataflow/`), not guessed from the alert message alone.

**`js/clear-text-logging`** (`CleartextLoggingCustomizations.qll`) sources on the *name* of a variable/property/call matching a `maybePassword()` regex — it is not value- or type-aware. A `boolean` field like `passwordSet` or `hasPassword` still matches because the name contains "password". It also over-taints: a shared, generically-typed helper (e.g. `expectValue`/`CentrsError` argv-parsing plumbing used by every CLI subcommand) gets one context-insensitive taint summary, so a *real* credential used as CLI argv in one command's test (e.g. `execute-ssh.test.ts` passing `auth.password`) can make an unrelated command's generic error-formatting path (e.g. `settings.ts`) look tainted, even though that path only ever logs a hardcoded literal (`` `Missing value for ${flag}.` ``). Don't rename public schema fields (e.g. `passwordSet`) just to dodge the heuristic — that's a bigger API change than the finding warrants. Dismiss with a justification naming which shape applies (name heuristic vs. shared-helper over-tainting).

**`js/insecure-temporary-file`** (`InsecureTemporaryFileCustomizations.qll`) sources on `os.tmpdir()` **or any string literal matching `/tmp/%`** — a hardcoded `"/tmp/foo"` test fixture path counts, with no actual temp-dir call needed. The sink is any `fs.open`/`writeFileSync`/etc. path argument where **no secure `mode` (no group/other permission bits, e.g. `0o600`) is passed** — the rule is about file permissions, not about collision-safety (`wx`/`O_EXCL` does not satisfy it). Two real, non-cosmetic fixes, both worth doing:
  1. Never hardcode a literal starting with `/tmp/` in a test; build the path under the test's own sandbox dir instead (see `test/integration/*.test.ts`'s `freshDir()`/`.scratch/` convention).
  2. Pass an explicit `0o600`-class mode to any `fs.open`/`writeFileSync` sink that creates a file which may hold credentials (CDB files, downloaded device backups) — this is real hardening (the file would otherwise inherit the process umask, often world/group-readable) and permanently satisfies the sink check regardless of future taint sources. Note `mkdtempSync(join(tmpdir(), prefix))` (see `src/transfer.ts`'s `withTempFile`) is the established safe pattern for real temp files — CodeQL does not currently model taint flowing through `mkdtempSync`'s return, and the directory is created `0o700` by Node regardless.
