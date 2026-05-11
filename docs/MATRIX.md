# Matrix

The product is a 2D grid of commands × protocols. This file is the **only**
source of truth for what is done. No alpha gates, no milestones, no roadmap
prose.

Pick the highest-priority cell that is not `CHR-passed`. That is the next
work. See `docs/CONSTITUTION.md` for the cell-state definitions.

## Cell states

| State          | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `—`            | Not applicable / out of scope for this protocol                 |
| `not-started` | No code and no design                                           |
| `designed`     | `commands/<name>/README.md` describes intent and flags          |
| `coded`        | Implementation exists in `src/`                                 |
| `CHR-passed`   | Every example in `commands/<name>/examples.md` is green on CHR  |

A cell advances only with the matching evidence in the same change.

## Grid

| Command  | rest-api      | native-api    | ssh           | mac-telnet    |
| -------- | ------------- | ------------- | ------------- | ------------- |
| retrieve | `coded`       | `not-started` | —             | —             |
| update   | `not-started` | `not-started` | `not-started` | —             |
| execute  | `not-started` | `not-started` | `not-started` | `not-started` |
| terminal | —             | —             | `not-started` | `not-started` |
| devices  | —             | —             | —             | —             |
| check    | `not-started` | `not-started` | `not-started` | `not-started` |

`devices` does not use a transport in the protocol sense; its data sources
(CDB, MNDP cache, dude.db import) are tracked in `commands/devices/README.md`.

## Priority order

Do not start a later item until the earlier ones are `CHR-passed`.

1. **retrieve / rest-api** — drive the envelope, validation, and error model
   to `CHR-passed` against real CHR. This is the shakedown for everything
   else. Specifically: fix the `/console/inspect` path-format bug exposed by
   `centrs retrieve <r> /system/resource` and `centrs retrieve <r> /ip/address`,
   keeping `validate=true` as the default. See `commands/retrieve/examples.md`.
2. **CDB resolution end-to-end** — name → user/password from
   `~/.config/tikoci/winbox.cdb`, including encrypted CDBs and the
   "unused --cdb-password" warning. Tested via retrieve.
3. **execute / rest-api** — first CLI-shaped command, `[:parse]` validator
   path, semi-structured output handling.
4. **CDB groups** — `--group` against retrieve and execute; envelope must
   round-trip group results.
5. **update / rest-api** — write-shaped operations with re-validate-server-side.
6. **devices** — list/inspect resolved targets and their provenance.
7. **native-api** for retrieve/update/execute — second transport, drives the
   protocol abstraction to its second consumer.
8. **ssh** for execute/terminal/transfer — third transport.
9. **mac-telnet** for terminal/execute — L2 path.
10. **MCP, TUI, proxy** — frontends over the stable core. Future targets;
    they shape interface decisions today but do not block the grid.

## Open questions (decisions needed before the affected cell can advance)

| Question | Affects cell | Notes |
| -------- | ------------ | ----- |
| Exact `/console/inspect` path-syntax for `print`/`get` verbs | retrieve / rest-api | Current `pathToInspectString` joins with commas; needs CHR confirmation. Fixing this unblocks priority #1. |
| MNDP cache shape and TTL policy | devices, name resolution | UDP broadcast 30/60s; need cache + expiry. |
| Bug-report rendering: inline flag, separate command, both? | cross-cutting | Constitution says envelope is rich enough; rendering deferred until needed. |
| L2 in CI: how to fake L2 net for mac-telnet on Linux runner | mac-telnet | Likely belongs in `quickchr`. |

When a question is answered, fold the answer into the relevant
`commands/<name>/README.md` or `docs/CONSTITUTION.md`, then delete the row.
