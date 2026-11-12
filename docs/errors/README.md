# centrs error pages

Each `CentrsError` carries a `details_url` of the form
`https://tikoci.dev/centrs/errors/<code>/`. This directory holds the
human-readable page for each code, and is the home for the **error URL scheme**
and the **RouterOS-fault mapping** (below); the constitution keeps only the
one-line contract.

## URL scheme

`details_url` is `https://tikoci.dev/centrs/errors/<code>/`, with `<code>`
the slash-namespaced code as-is and a trailing slash (e.g.
`https://tikoci.dev/centrs/errors/routeros/unknown-path/`).

- The host is the site's canonical custom domain over HTTPS, and the trailing
  slash is the page's own URL, so a fetch gets 200 with no redirect. Links
  emitted before 0.2.0 used `https://tikoci.github.io/centrs/errors/<code>`;
  GitHub Pages still redirects those to the custom domain, but through plain
  HTTP, which some agent fetch tools refuse to follow (#464).

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
- `quickchr/*` — the quickchr named-live-provider (`--quickchr <name>`): optional
  package availability, descriptor version support, and machine lookup/liveness
  (`src/resolver/quickchr-provider.ts`).
- `routeros/*` — RouterOS-surfaced faults mapped by the grounded vocabulary in
  `src/core/routeros-errors.ts` (REST `detail` and native-api `!trap`, identical
  on CHR 7.23).
- `settings/*` — settings/value parsing (`src/resolver/settings.ts`) and the
  `centrs settings` command's own registry/refusal rules (`src/settings.ts`).
- `target/*` — turning a `<router>` into a transport endpoint.
- `transport/*` — connection, TLS, DNS, and timeout plumbing.
- `usage/*` — how a command was invoked (arity, conflicting flags, confirmation).
- `validation/*` — the canonicalize → validate gate (`:parse` + `/console/inspect`).
- `wait/*` — readiness/condition deadlines and cancellation (`retrieveWait`).

The hand-enriched pages (richer trigger strings and remediation) currently are
the `routeros/*` set produced by `src/core/routeros-errors.ts`, the
`target/*` MAC-resolution pages, the `wait/*` deadline/cancellation pages, and
the common connection faults (`transport/connection-refused`, `network`,
`timeout`, `dns`, `tls-certificate`, `host-key-mismatch`, `connection-closed`,
`incomplete-transfer`, and `auth/failed`); the rest are generated stubs to be
enriched as each code is grounded. The Pages build lists every code on the
catalog index and rewrites these pages' relative links for the site.

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
