# Data-source grounding matrix

This is a draft evidence matrix. It is not a spec. Promote stable requirements
to S003/S004 only after source formats, authority, and credential handling are
grounded.

| Source | Authority level | Data shape | Credential handling | Persistence policy | Reference source | Fixture/test needs | Current status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Explicit CLI/API/MCP input | Highest | Host/IP/MAC, protocol, port, username, password/token, path/command | Provided for the current call; never silently persisted | No persistence unless caller opts in through typed setting | S003/S004 | Unit tests for precedence, redaction, and non-persistence | Alpha source |
| Environment variables and `.env` | High default | `CENTRS_*` settings from S004 | Automation-friendly; redacted in diagnostics | Loaded by Bun/environment, not written by `centrs` | S004 | Unit tests for precedence, source reporting, and redaction | Alpha source |
| SQLite cache | Confirmed local metadata when explicitly persisted | Device registry, source provenance, last-seen timestamps, capabilities, maybe service probes | Credentials excluded unless a future explicit secret policy allows otherwise | Native cache controlled by typed persistence settings | S003 plus future work | Schema migration, provenance, stale-row, and no-credential tests | Planned after target model is typed |
| WinBox CDB | Candidate first-class device store and imported local user database | Devices, groups, addresses, usernames, saved passwords, workspace, RoMON agent, and comments/notes; apparent entry key is `address + user` while group is an attribute | Security-sensitive; imports and writes must be explicit and auditable; evaluate `CENTRS_PASSWORD`, `CENTRS_CDB_PASSWORD`, and CDB-specific mode settings before accepting names | Read/import first; write/export only after open/encrypted file behavior, merge/update semantics, and fixture coverage are grounded | `test/fixtures/winbox-cdb/`, `RouterOS_Tools`, future CDB spike | Safe synthetic open/encrypted CDB fixtures; no real private databases; field length and compatibility tests | Provisional default-device-store candidate; high-risk research gap |
| Dude DB | Imported monitoring inventory | SQLite database with Nova message payloads for devices, services, probes, groups, and credentials depending on DB contents | Security-sensitive; `donny` documents device usernames/passwords as plaintext, so imports must redact by default | Prefer read/import with provenance; avoid write until justified | `donny` | `dude.db` and `export.dude` fixtures from safe generated labs | Grounded reference exists |
| MNDP observations | Live hint only | Identity, MAC, IP, interface, version, board, uptime, first/last seen | No credentials | Persist only when scan mode requests it; stale rows are not proof | `mcp-mikrotik`, `routeros-mndp`, rosetta docs | Parser fixtures and live scan/lab tests | Grounded enough for discovery design |
| Credential store | Secret source, not inventory | Passwords, tokens, keys, secret metadata | Must be explicit, redacted, platform-aware, and auditable | Defer Keychain/secret-store until alpha retrieve works | SECURITY.md, S003/S004 | Redaction, non-persistence, and source-label tests | Deferred |

## Open questions

- Is WinBox CDB compatible enough to use as canonical `centrs` device storage,
  or should it remain an explicit import/export/provider feeding a separate
  internal SQLite cache?
- Which sample CDB files can be safely generated and committed?
- Should Dude DB imports depend on `@tikoci/donny` directly or vendor a narrower
  reader later?
- What cache schema supports both IP-first and MAC-first targets without making
  MNDP authoritative?
- How should imported secret-bearing sources report "credential present" without
  exposing the secret or silently promoting it into the native cache?
- What are the maximum field lengths, especially for comments/notes if they store
  `key=value` metadata such as non-default ports?
- Can CDB records be extended with new fields without breaking WinBox 3.x/4.x, or
  should `centrs` stay inside existing fields only?
- How should non-RouterOS secrets such as SNMP communities be represented if the
  CDB password field is router-login-shaped?

## WinBox CDB provisional model

- WinBox UI appears to treat "Save to list" as add/update in the loaded CDB and
  "with password" as whether the password is saved in that entry.
- "Remember password" is a login UI convenience, not a CDB entry field. The
  analogous `centrs` concept is a single current password source such as
  `CENTRS_PASSWORD` or a frontend-specific secret prompt.
- Only one CDB file is loaded by WinBox at a time. "Open" chooses a file, "Move"
  relocates the current file, "Import" merges another CDB into the current one,
  and "Export" writes a copy without changing the loaded file.
- The effective CDB update key appears to be `address + user`: changing group for
  the same address/user moves the existing row rather than creating a new one.
- Group, workspace, RoMON agent, and comments/notes should be modeled as row
  attributes until compatibility tests prove a richer structure.
- Comments/notes may be useful for RouterOS-style `key=value` metadata such as
  non-default protocol ports, but this remains provisional until length,
  escaping, and WinBox compatibility are tested.
- Open versus encrypted CDB mode should be explicit. Creating or encrypting a CDB
  must not silently reuse an unrelated RouterOS password.
