# Data-source grounding matrix

This is a draft evidence matrix. It is not a spec. Promote stable requirements
to S003/S004 only after source formats, authority, and credential handling are
grounded.

| Source | Authority level | Data shape | Credential handling | Persistence policy | Reference source | Fixture/test needs | Current status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Explicit CLI/API/MCP input | Highest | Host/IP/MAC, protocol, port, username, password/token, path/command | Provided for the current call; never silently persisted | No persistence unless caller opts in through typed setting | S003/S004 | Unit tests for precedence, redaction, and non-persistence | Alpha source |
| Environment variables and `.env` | High default | `CENTRS_*` settings from S004 | Automation-friendly; redacted in diagnostics | Loaded by Bun/environment, not written by `centrs` | S004 | Unit tests for precedence, source reporting, and redaction | Alpha source |
| SQLite cache | Confirmed local metadata when explicitly persisted | Device registry, source provenance, last-seen timestamps, capabilities, maybe service probes | Credentials excluded unless a future explicit secret policy allows otherwise | Native cache controlled by typed persistence settings | S003 plus future work | Schema migration, provenance, stale-row, and no-credential tests | Planned after target model is typed |
| WinBox CDB | Imported local user database | Devices, groups, addresses, ports, usernames, passwords if readable | Security-sensitive; imports must be explicit and auditable | Read/import only until format and encryption are grounded | Unknown; needs CDB research | Safe synthetic/sample CDB fixtures; no real private databases | High-risk research gap |
| Dude DB | Imported monitoring inventory | SQLite database with Nova message payloads for devices, services, probes, groups, and credentials depending on DB contents | Security-sensitive; `donny` documents device usernames/passwords as plaintext, so imports must redact by default | Prefer read/import with provenance; avoid write until justified | `donny` | `dude.db` and `export.dude` fixtures from safe generated labs | Grounded reference exists |
| MNDP observations | Live hint only | Identity, MAC, IP, interface, version, board, uptime, first/last seen | No credentials | Persist only when scan mode requests it; stale rows are not proof | `mcp-mikrotik`, `routeros-mndp`, rosetta docs | Parser fixtures and live scan/lab tests | Grounded enough for discovery design |
| Credential store | Secret source, not inventory | Passwords, tokens, keys, secret metadata | Must be explicit, redacted, platform-aware, and auditable | Defer Keychain/secret-store until alpha retrieve works | SECURITY.md, S003/S004 | Redaction, non-persistence, and source-label tests | Deferred |

## Open questions

- Is WinBox CDB compatible enough to import directly, or should `centrs` use an
  internal schema with explicit import/export?
- Which sample CDB files can be safely generated and committed?
- Should Dude DB imports depend on `@tikoci/donny` directly or vendor a narrower
  reader later?
- What cache schema supports both IP-first and MAC-first targets without making
  MNDP authoritative?
- How should imported secret-bearing sources report "credential present" without
  exposing the secret or silently promoting it into the native cache?
