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

| Command  | rest-api      | native-api    | ssh           | mac-telnet    | snmp          | mndp          | romon         | winbox-terminal |
| -------- | ------------- | ------------- | ------------- | ------------- | ------------- | ------------- | ------------- | ---------------- |
| retrieve | `CHR-passed`  | `not-started` | —             | —             | `not-started` | —             | —             | —                |
| update   | `not-started` | `not-started` | `not-started` | —             | —             | —             | —             | —                |
| execute  | `not-started` | `not-started` | `not-started` | `not-started` | —             | —             | `not-started` | `not-started`    |
| terminal | —             | —             | `not-started` | `not-started` | —             | —             | —             | —                |
| devices  | —             | —             | —             | —             | —             | —             | —             | —                |
| discover | —             | —             | —             | —             | —             | `not-started` | —             | —                |
| check    | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started` | `not-started`    |

`devices` does not use a transport in the protocol sense, so its grid row
stays `—`. Its cell state is `coded`: the read-only subset (`list`, `show`,
`groups`) is implemented in `src/devices.ts` and green under
`bun run test:integration` against a CDB fixture built in-test from the
known CDB primitives (open + encrypted via `--cdb-password`). It advances
to `CHR-passed` when every example in `commands/devices/examples.md` is
green via `bun run test:integration` — that still requires `add`, `edit`,
`set`, `remove`, ambiguity / `--match`, and the provenance/override examples.
Data sources (CDB, ARP cache, MNDP cache, `dude.db` import) and their
phasing live in `commands/devices/README.md`.

## Priority order

Do not start a later item until the earlier cell or dependency checkpoint has
matching evidence.

1. **retrieve / rest-api** — `CHR-passed` against real CHR. This is the
   shakedown for everything else. See `commands/retrieve/examples.md`.
2. **CDB resolution and metadata overrides** — target → user/password from
   WinBox CDB, including the unused `--cdb-password` warning, comment-kv
   `via`/`port` overrides, and MAC resolution order (CDB, then ARP when opted
   in).
3. **CDB groups and fanout** — `--group`, multi-target de-dupe, concurrency,
   and outer/inner envelope shape must be grounded before execute starts.
4. **execute / rest-api** — first CLI-shaped command, `[:parse]` validator
   path, semi-structured output handling.
5. **update / rest-api** — write-shaped operations with re-validate-server-side.
6. **devices** — complete CDB mutation (`add`, `remove`, `set`, `edit`) and
   provenance.
7. **retrieve / snmp** — SNMP OID/MIB reads with MikroTik MIB download/cache.
8. **native-api** for retrieve/update/execute — second transport, drives the
   protocol abstraction to its second consumer.
9. **ssh** for execute/terminal/transfer — third transport and key-management
   scheme.
10. **mac-telnet** for execute/terminal — L2 path, default execute route for
    unresolved MAC targets.
11. **RoMON / WinBox Terminal for execute** — lower-priority execute surfaces
    after mac-telnet is grounded.
12. **discover / mndp** — `discover --save --timeout 60s` populates CDB entries
    with provenance metadata and `group=discovered`.
13. **MCP, TUI, proxy** — frontends over the stable core. Future targets;
    they shape interface decisions today but do not block the grid.

## Open questions (decisions needed before the affected cell can advance)

| Question | Affects cell | Notes |
| -------- | ------------ | ----- |
| MNDP cache shape and TTL policy | devices, name resolution | UDP broadcast 30/60s; need cache + expiry. |
| SNMP MIB cache policy | retrieve / snmp | Decide cache location, invalidation, RouterOS version/channel matching, and offline behavior for MIB-name lookup. |
| SSH key management | execute / ssh, terminal / ssh | Decide CDB comment-kv keys, CLI flags, env names, and redaction for stored key paths or key material. |
| Bug-report rendering: inline flag, separate command, both? | cross-cutting | Constitution says envelope is rich enough; rendering deferred until needed. |
| L2 in CI: how to fake L2 net for mac-telnet on Linux runner | execute / mac-telnet, terminal / mac-telnet | Likely belongs in `quickchr`; must cover unresolved-MAC default behavior. |
| RoMON / WinBox Terminal validation and CI | execute / romon, execute / winbox-terminal | Lower priority than mac-telnet; need reference tooling and typed failure mapping before advancing. |

When a question is answered, fold the answer into the relevant
`commands/<name>/README.md` or `docs/CONSTITUTION.md`, then delete the row.
