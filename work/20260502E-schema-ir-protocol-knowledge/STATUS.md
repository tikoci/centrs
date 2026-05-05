# Status: schema IR protocol knowledge spike

<!-- cspell:ignore WBX -->

## Current state

- Work item created from the May 1 protocol/data grounding review.
- No code, dependencies, or generated artifacts have been added.
- The idea is explicitly exploratory.
- As of 2026-05-04, this centrs spike is effectively subsumed by
  [tikoci/m2ir](https://github.com/tikoci/m2ir), which became the home for the
  lower-level RouterOS primitive / schema-IR direction that all APIs funnel down
  into on the router.
- The most relevant follow-up note from that project for centrs right now is
  `~/GitHub/m2ir/work/2026-05-winbox-nova-sources/winbox-nova-source-inventory.md`,
  because it surfaced additional public CDB/WBX references that feed back into
  `work/20260502A-winbox-cdb-device-store/`.

## Disposition

- Close this work item in `centrs` unless a centrs-local requirement appears
  that `m2ir` cannot carry.
- Treat `m2ir` as the active place for schema algebra / lower-level IR design.
- Keep only concrete format findings that change centrs behavior or grounding in
  centrs-local work items such as the WinBox CDB spike.

## Deferred or rejected

- Adding a dependency is deferred.
- Broad schema infrastructure is rejected unless a small RouterOS data slice
  proves value first.
