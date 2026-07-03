# `settings/unknown-key`

`settings get`/`set`/`reset` received a token that is not a recognized CENTRS_*-shaped setting.

## Fix

`centrs settings get <attr>`, `set <attr> <value>`, and `reset <attr>` all
normalize the token first — with or without the `CENTRS_` prefix, in
kebab-case or SCREAMING_SNAKE (`format`, `FORMAT`, `centrs_format`, and
`CENTRS_FORMAT` all resolve to the same key) — then look it up against the 13
keys `settings` manages plus the 5 refused keys. This error fires when the
normalized token matches neither list: a typo, a made-up name, or a
`CENTRS_*` var no shipped command actually reads (see
`commands/settings/README.md`, "Not yet wired — exclude from v1", for three
such names that are deliberately unsupported today).

Run `centrs settings print --all` to see every key `settings` recognizes,
plus any unrecognized `CENTRS_*` lines already present in the file, tagged
`(unrecognized)` — that second list is the fastest way to spot a typo you
already wrote into `centrs.env` by hand.

This is a different failure from [`settings/reserved-key`](reserved-key.md):
that error means "this is a real setting, but writing it is off-limits";
`settings/unknown-key` means the token isn't a setting `centrs` knows about
at all. See examples 9 and 19 in `commands/settings/examples.md`.
