# update

Write RouterOS state. Models `<path>/<verb>` where the verb is `add`, `set`,
`remove`, or `disable`/`enable` style.

Status: `not-started`. This file is a stub. Promote when `retrieve` is
`CHR-passed` and `execute` has shaped the envelope for write-shaped output.

## Intent

- Validate before run; re-validate server-side immediately before execute (see
  constitution).
- Refuse without an explicit target. No "default router."
- Write operations require structured input (object → REST body /
  native-API key=value pairs). CLI-string forms route through `execute`.
- Group writes (`--group`) must round-trip the per-target outcome through the
  envelope: which targets succeeded, which failed, why.

Defer until `retrieve` plus a CDB groups walkthrough are in place.
