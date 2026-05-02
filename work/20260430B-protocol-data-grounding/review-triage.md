# May 1 review triage

This file records how the long local review note was incorporated without making
the temporary note a durable source. Each material idea should land as promoted,
spike, deferred, or rejected.

## Promoted into this work item

- WinBox CDB is now recorded as a candidate first-class/default device data
  target, while still marked provisional.
- CDB keying is captured as `address + user`, with group treated as an attribute
  rather than a key.
- WinBox UI terms are captured as design alignment material for future
  `centrs devices` UX.
- `CENTRS_PASSWORD`, `CENTRS_CDB_FILE`, `CENTRS_CDB_PASSWORD`, and
  `CENTRS_CDB_MODE` are captured as vocabulary to evaluate before S004 changes.
- Default RouterOS service/port discovery is captured as future `check` and
  protocol-upgrade grounding.
- SSH text-output caveats and file-transfer candidates are captured in the
  protocol matrix.
- WinBox/Nova is captured as strategic research that may inform CDB, Dude DB,
  RoMON proxy, and terminal-over-WinBox work even if no WinBox adapter ships.

## Split into focused spikes

- `work/20260502A-winbox-cdb-device-store/` covers CDB format, encryption,
  keying, fixtures, password policy, and whether CDB is canonical storage or a
  provider.
- `work/20260502B-routeros-l2-lab/` covers MNDP, MAC Telnet, RoMON, and the L2
  lab topology needed before implementation.
- `work/20260502C-winbox-terminal/` covers terminal-over-WinBox feasibility and
  whether the result should be an adapter, launcher, or non-goal.
- `work/20260502D-wireshark-dissector-inventory/` covers source-pinning
  dissectors for MNDP, MAC Telnet, RoMON, and WinBox.
- `work/20260502E-schema-ir-protocol-knowledge/` covers the schema algebra idea as
  exploratory protocol-knowledge infrastructure.

## Deferred

- Repo-local `SKILL.md` and custom agents remain deferred until repeated work
  proves scoped instructions plus user-level skills are insufficient.
- Direct use of `donny` as a dependency is deferred; it remains an evidence and
  schema reference for Dude DB and Nova data.
- Native API multiplexing remains a research topic before it is used for
  eventing, validation, or proxy streams in core code.
- CDB comment/note metadata remains provisional until field limits, escaping, and
  WinBox compatibility are tested.
- Non-RouterOS secrets such as SNMP communities need a separate representation
  decision before CDB or SQLite storage is specified.

## Rejected for now

- Do not treat the temporary review note itself as a committed source reference.
- Do not silently persist credentials from CDB, Dude DB, discovery, or prompts.
- Do not automatically encrypt a new CDB using an unrelated RouterOS password.
- Do not assume CDB records can be safely extended with new fields until tested
  across relevant WinBox versions.
- Do not claim WinBox Terminal support from TCP 8291 reachability alone.
