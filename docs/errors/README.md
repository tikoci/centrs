# centrs error pages

Each `CentrsError` carries a `details_url` of the form
`https://tikoci.github.io/centrs/errors/<code>`. This directory holds the
human-readable page for each code. The constitution requires one page per error
code (`docs/CONSTITUTION.md`, "Error URL scheme").

## Source of truth and the contributor contract

The enumerable list of every code lives in code, not here:
[`src/core/error-catalog.ts`](../../src/core/error-catalog.ts). The per-code
pages in this directory are generated from it (`bun run docs:errors`, which
only scaffolds missing pages and never overwrites hand-enriched ones).

When you introduce a new error code you must, in the same change:

1. add an entry to `src/core/error-catalog.ts`, and
2. add a `docs/errors/<code>.md` page (run `bun run docs:errors`).

`test/unit/error-pages.test.ts` enforces this three-way consistency — every live
`code:` literal is cataloged, every catalogued code has a page, and no page is
orphaned. A missing page is a centrs bug, so the guard fails the build.

## Families

Codes are slash-namespaced `family/slug`. The families and where they originate:

- `auth/*` — credential rejection.
- `cdb/*` — WinBox CDB load, parse, decrypt, mutation, and allowlist policy
  (`src/data/`, `src/devices.ts`, `src/resolver/cdb.ts`).
- `discover/*` — MNDP discovery (`src/discover.ts`).
- `identity/*` — target → CDB record resolution (`src/resolver/`).
- `input/*` — malformed caller input (paths, MACs, arguments).
- `internal/*` — centrs bugs / unreachable states.
- `mndp/*` — MNDP wire codec and listener (`src/data/mndp.ts`).
- `routeros/*` — RouterOS-surfaced faults mapped by the grounded vocabulary in
  `src/core/routeros-errors.ts` (REST `detail` and native-api `!trap`, identical
  on CHR 7.23).
- `settings/*` — settings/value parsing (`src/resolver/settings.ts`).
- `target/*` — turning a `<router>` into a transport endpoint.
- `transport/*` — connection, TLS, DNS, and timeout plumbing.
- `usage/*` — how a command was invoked (arity, conflicting flags, confirmation).
- `validation/*` — the canonicalize → validate gate (`:parse` + `/console/inspect`).

The hand-enriched pages (richer trigger strings and remediation) currently are
the `routeros/*` set produced by `src/core/routeros-errors.ts` and the
`target/*` MAC-resolution pages; the rest are generated stubs to be enriched as
each code is grounded.
