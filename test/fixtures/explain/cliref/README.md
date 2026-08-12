# Frozen CLI-Reference pages

Pages of MikroTik's published CLI Reference, frozen so the catalog parser
(`scripts/explain-catalog-data.ts`, #228) can be tested without a network.

| File | Source | Captured | Why this page |
| ---- | ------ | -------- | ------------- |
| `partitions.md` | <https://manual.mikrotik.com/docs/cli-reference/partitions.md> | 2026-08-06 | Every shape in one small page: a body-level `#` heading that repeats the title, `Conditions` + `Syscap` gates, a `Flag` table, `Argument` and `Read-only Argument` tables, one Directory and five Commands. It is also one of the hardware-gated paths (`syscap: partitions`) that #228 is about — absent from every CHR-derived tree, and self-documented as to why. |
| `tool__mac-server.md` | <https://manual.mikrotik.com/docs/cli-reference/tool/mac-server.md> | 2026-08-06 | The `/tool mac-server mac-winbox` case #207 was filed on, and the only page here with `Settings Directory` entries. Filename mirrors the generator's `--cache` naming (`/` → `__`). |
| `system__health__health.md` | <https://manual.mikrotik.com/docs/cli-reference/system/health/health.md> | 2026-08-12 | Both #285 shapes on one page: a `<dir>/<basename>` leaf — the kind sitemap-only discovery dropped — publishing its path TWICE, as a `Settings Directory` (`!i386`) and a `Directory` (`syscap: health`). That pair is why "one entry per page" is not an invariant and why occurrences that differ only in container kind are folded rather than refused. |

**The first two pages no longer exist at those URLs.** MikroTik reshaped the CLI
Reference from module pages into per-command leaf pages (#285,
tikoci/rosetta#137), so `partitions.md` is now six leaves under `partitions/`
and `tool/mac-server.md` is four under `tool/mac-server/`. They are kept
deliberately, in their captured module-page shape: multi-heading pages with
intra-page nesting are what prove the parser still reads that shape, and no
current page nests. Do not "refresh" them — re-capturing would silently delete
that coverage. `system__health__health.md` is the current shape.

These are documentation excerpts, retained under MikroTik's manual terms for
test purposes only; they are not redistributed as a product artifact. They are
**not** device truth — only a live router establishes what a given RouterOS
build actually accepts.

A parser change that alters what these produce is a deliberate change, and the
tests in `test/unit/explain-catalog.test.ts` say what the current reading is.
