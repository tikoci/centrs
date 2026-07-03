# `settings/skip-env-file-active`

`settings print` ran under --skip-env-file; the shown centrs.env values would not apply to other commands run in the same environment.

## Fix

This is an informational warning, not a failure — `centrs settings print`
still returns `ok: true` with the file's real contents. It appears only when
`--skip-env-file` (or `CENTRS_SKIP_ENV_FILE`) was active on that same
`print` invocation, as a reminder that the flag doesn't apply to `settings`
itself: `settings` always reads and writes the real `centrs.env` file
regardless of `--skip-env-file`, since inspecting/editing the file is this
command's whole job (see the module doc comment at the top of
`src/settings.ts`).

What the warning is actually flagging is every *other* command: if
`--skip-env-file`/`CENTRS_SKIP_ENV_FILE` is also active when you run
`retrieve`/`execute`/`transfer`/`api` in that same shell or environment,
those commands' resolvers skip loading `centrs.env` as a settings source —
so the values `print` just showed you would not apply there. There's
nothing to fix; either drop `--skip-env-file` if you want other commands to
see these values, or ignore the warning if the isolation is intentional. See
example 6 in `commands/settings/examples.md`, and
[`docs/CONSTITUTION.md`](../../CONSTITUTION.md) (Settings precedence) for how
the config tier fits into the precedence ladder.
