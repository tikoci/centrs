# `settings/invalid-format`

An unsupported output format was requested.

## Fix

`centrs settings set format <value>` throws this when `<value>` isn't one of
`text`, `json`, or `yaml` — the same `{text, json, yaml}` set every
command's own `--format` flag (and `CENTRS_FORMAT`) validates against
(`retrieveOutputFormats` and its `execute`/`transfer`/`api` counterparts).
`centrs settings set format xml` is the canonical trigger; see example 14 in
`commands/settings/examples.md`. A failed `set` never partially writes — the
file is unchanged.

`format` is the one managed key without a single universal built-in
default: `retrieve`/`execute`/`transfer` default to `text`, but `api`
defaults to `json`. Because of that, `centrs settings print`/`get format`
can't report one scalar default when the key is unset — it reports a
`perCommandDefault` map (`{ retrieve: "text", execute: "text", transfer:
"text", api: "json" }`) instead, so this is the one key where "unset" looks
different in the output shape than every other key.

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) (Settings precedence) for
where `format` sits in the resolver chain once a value is set.
