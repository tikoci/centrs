# Data Source Rules

Follow `docs/CONSTITUTION.md` (identity / CDB sections) and
`commands/devices/README.md`.

- Keep device source provenance visible: explicit input, environment, SQLite cache, WinBox CDB, The Dude `dude.db`, and MNDP are not equally authoritative.
- Do not silently persist credentials or discovered devices. Persistence must be controlled by a typed setting and explained in interactive output.
- MNDP is a hint source. Lack of MNDP data must not make a device invalid.
- Prefer shared SQLite infrastructure over one database per feature unless a spec justifies separation.
- Reuse tikoci `donny` knowledge for Dude database structures and related Nova/TLV encoding.
