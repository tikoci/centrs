# centrs error pages

Each `CentrsError` carries a `details_url` of the form
`https://tikoci.github.io/centrs/errors/<code>`. This directory holds the
human-readable page for each code, and is the home for the **error URL scheme**
and the **RouterOS-fault mapping** (below); the constitution keeps only the
one-line contract.

## URL scheme

`details_url` is `https://tikoci.github.io/centrs/errors/<code>`, with `<code>`
the slash-namespaced code as-is (e.g.
`https://tikoci.github.io/centrs/errors/routeros/unsupported-path`).

- The URL is normalized; the GitHub Pages site routes it to a human page — **not**
  the typedoc URL (typedoc lives elsewhere).
- Adding an error code requires adding a Pages entry under the same path: code and
  page ship together, and a missing page is a centrs bug.
- The URL must stay **stable across centrs versions**; if a code is renamed, the
  old URL must redirect.

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

## RouterOS-fault mapping (`routeros/*`)

The authoritative vocabulary for `routeros/*` is the live router's own strings
(grounded on CHR 7.23): the REST `detail` field on HTTP ≥400 — shape
`{"detail":"<msg>","error":<http-status>,"message":"<http reason>"}` — and the
native-api `!trap` carry the **same** text for the same fault, so one shared
table (`src/core/routeros-errors.ts`) maps both transports. The original string
is always preserved — in `context.detail` for a matched rule, and in `cause` for
the catch-all (`routeros/request-failed`). Ground new mappings on CHR evidence,
not assumption (`tikoci/m2ir` is protocol-IR reference, not an accessible mapping
source — the router strings are).
