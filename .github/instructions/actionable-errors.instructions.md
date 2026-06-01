---
applyTo: "src/**,docs/CONSTITUTION.md,docs/errors/**,commands/**"
---

# Actionable errors

Error messages are part of the public API.

- Explain what failed, why it matters, and the next action the caller can take.
- Include RouterOS path, protocol, device source, and validation source when those details explain the failure.
- When a local tool is required, check for it where practical and suggest a platform-aware install or workaround.
- Do not hide internal error details; attach them as structured cause/debug data instead of making the main message unreadable.

## Error-code registration (one place, one page)

Every `CentrsError` code is registered once in
[`src/core/error-catalog.ts`](../../src/core/error-catalog.ts) and has exactly
one human page at `docs/errors/<code>.md`. When you add or rename a code:

- Add (or update) its entry in `src/core/error-catalog.ts` with a canonical
  one-line summary of the fault class.
- Scaffold the page with `bun run docs:errors` (it never overwrites existing
  pages), then enrich `docs/errors/<code>.md` with the typical trigger and fix.
- Reuse an existing code before minting a new one — each new code costs a
  catalog entry and a page.

`test/unit/error-catalog.test.ts` and `test/unit/error-pages.test.ts` enforce
this: a live `code:` literal with no catalog entry, or a catalog code with no
page, fails the build. Do not weaken those guards to land a change.
