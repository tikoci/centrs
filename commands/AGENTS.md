# commands/

Each `commands/<name>/` holds the **executable spec** for one command:

- `README.md` — intent, flags, behavior. The "designed" tier.
- `examples.md` — numbered, runnable examples. Each example is one assertion in
  the matching `test/integration/<name>.test.ts`; example N ↔ assertion N. This
  is what `CHR-passed` is measured against.

Do not restate the constitution here or in a command README — link to
`docs/CONSTITUTION.md` for envelope, errors, settings precedence, target
selection, and protocol selection. The identity/CDB **resolution depth** (lookup
keys, ambiguity, `__default__`, comment-kv allowlist, write strategy) lives in
`commands/devices/README.md` — the registry command owns it; the constitution
keeps only the identity/CDB principle. A command file covers only what is
specific to that command. `docs/MATRIX.md` is the only status surface; a
README's "Status" line must agree with it.

## Verb vocabulary

Commands are centrs **verbs** (`retrieve`, `execute`, `api`, `devices`,
`discover`, `check`, `explain`, `terminal`, `settings`), never one tool per
RouterOS command. Open-ended follow
is folded into `api --stream` (no separate `stream` verb). Sub-verbs and their
aliases are canonical across CLI / API / MCP:

| Canonical | Aliases          | Meaning                                  |
| --------- | ---------------- | ---------------------------------------- |
| `list`    | `print`          | Read many records. (`print` is RouterOS muscle-memory.) |
| `show`    | `get`            | Read one resolved record.                |
| `add`     | —                | Create; refuses an existing target.      |
| `set`     | —                | Modify an existing record (same flags as `add`). |
| `remove`  | `rm`, `delete`   | Delete a record.                         |
| `edit`    | —                | **Reserved** for the future clack/TUI wizard. Not a field-editing verb. |
| `groups`  | —                | List distinct groups.                    |

Canonical names win in help text and docs; aliases resolve to the canonical verb
silently. `add` and `set` are symmetric (same flags + `k=v` tokens), differing
only on existence. There is no `update` verb — RouterOS add/set/remove ride
`execute` (constitution: protocol selection).

## Help system

Shared across CLI / API / MCP help rendering:

- **Level-aware help.** `<command> <subcommand> --help` is more specific than
  `<command> --help` — e.g. `centrs devices remove --help` shows the `remove`
  usage and flags, not the whole `devices` surface.
- **"Did you mean?"** On an unknown verb/sub-verb or flag, the error
  (`input/invalid-command` / usage error) lists the closest canonical matches
  (Levenshtein) plus accepted aliases — extending the invalid-command behavior
  that already enumerates canonical verbs + aliases.
