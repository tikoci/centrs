# Frozen CLI-Reference pages

Two pages of MikroTik's published CLI Reference, captured verbatim on
**2026-08-06** and frozen so the catalog parser
(`scripts/explain-catalog-data.ts`, #228) can be tested without a network.

| File | Source | Why this page |
| ---- | ------ | ------------- |
| `partitions.md` | <https://manual.mikrotik.com/docs/cli-reference/partitions.md> | Every shape in one small page: a body-level `#` heading that repeats the title, `Conditions` + `Syscap` gates, a `Flag` table, `Argument` and `Read-only Argument` tables, one Directory and five Commands. It is also one of the hardware-gated paths (`syscap: partitions`) that #228 is about — absent from every CHR-derived tree, and self-documented as to why. |
| `tool__mac-server.md` | <https://manual.mikrotik.com/docs/cli-reference/tool/mac-server.md> | The `/tool mac-server mac-winbox` case #207 was filed on, and the only page here with `Settings Directory` entries. Filename mirrors the generator's `--cache` naming (`/` → `__`). |

These are documentation excerpts, retained under MikroTik's manual terms for
test purposes only; they are not redistributed as a product artifact. They are
**not** device truth — only a live router establishes what a given RouterOS
build actually accepts.

Refresh by re-fetching the two URLs above. A parser change that alters what
these produce is a deliberate change, and the tests in
`test/unit/explain-catalog.test.ts` say what the current reading is.
