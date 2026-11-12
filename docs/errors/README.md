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

The Pages build lists every code on the catalog index and rewrites the pages'
relative links for the site. `test/unit/error-pages.test.ts` checks those links
on every PR, and holds a shrinking list of pages that are still scaffold stubs
(#659): a new scaffold fails until it is written, and a written page leaves
the list.

## Page contract

The envelope already carries the code, a one-line `summary` and a one-line
`remediation`. A page is for what does not fit on that line: fixes that depend
on the transport, version or platform, causes that interact, and the cases
with no fix. Keep pages short. This shape is a baseline for authors and
reviewers, not a form to fill; leave a section out when it has nothing to say,
and depart from it when a code needs to.

1. **H1** — `` # `<code>` ``, exactly (the test checks it).
2. **Lead** (one or two sentences, required) — what failed, and whether
   anything ran or changed on the device. It must agree with the catalog
   summary, which MCP resources serve on its own.
3. **Emitted by** (required when more than one command or transport raises
   it) — which commands and `--via` transports. This tells a reader whether
   switching transport can help.
4. **Context** — what each `context.*` key means.
5. **Typical triggers** — each one says where it comes from: *(code)* read from
   the emission site, *(CHR 7.x)* reproduced on a device, *(field)* seen in a
   real session, or *(unverified)*. An unverified trigger is allowed and is
   better than silence; it is never written as fact.
6. **Fix** — ordered, concrete `centrs` and RouterOS commands.
7. **Limits** — RouterOS versions, platforms or transports where no fix exists.
8. **If this looks wrong** — the centrs bug it most likely is (a missing
   mapping, a wrong suggestion, a stale install) and what to put in an issue:
   the command, the `--json` envelope, `centrs --version`. There is no
   `--bug-report` flag.
9. **Related** — sibling codes, as relative `.md` links.

RouterOS-side claims follow
[`routeros-grounding.instructions.md`](../../.github/instructions/routeros-grounding.instructions.md).
A page for a code that only rides as a warning (warnings carry no
`details_url`) is reached from this index alone, so it can be a lead and a fix.
`internal/*` pages say that the code is a centrs bug and what to report.

A code that is no longer emitted keeps its page, marked **Retired** in the
lead, when it shipped in a release (the URL is stable). A code that never
shipped is removed with its page.

### Tips

Tips follow the same contract with one difference: most tips need no page. A
tip is advice whose `message` and `fix` already say everything; it gets a page
only when its advice does not fit in one sentence of about 40 words, or when
it depends on the version, platform or transport. A tip with a page is flagged
`page: true` in [`src/core/tip-catalog.ts`](../../src/core/tip-catalog.ts), its
page is `docs/tips/<slug>.md`, and only then does it carry a `detailsUrl`
(`https://tikoci.dev/centrs/tips/<slug>/`, without the `tip/` segment).
`test/unit/tip-catalog.test.ts` keeps the flag and the file in step.

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
