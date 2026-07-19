# centrs CLI reference

<!-- GENERATED FILE — do not edit. Regenerate with `bun run docs:cli`. -->
<!-- Source of truth: the CliCommandMetadata objects in src/cli/*.ts -->

Every flag below is generated from the same metadata that renders
`centrs <command> --help`; CI fails when this file and the metadata drift
(`bun run docs:cli --check`). Behavior, examples, and designed-but-not-yet
implemented flags live in each command's `commands/<name>/README.md`.

| Command | Summary |
| ------- | ------- |
| [`retrieve`](#retrieve) | Read RouterOS values through the shared core using the selected protocol. |
| [`execute`](#execute) | Run a RouterOS read or write command via native API, REST, or mac-telnet. |
| [`api`](#api) | Structured RouterOS API passthrough (gh-api style) over REST or native API. |
| [`transfer`](#transfer) | Copy files to/from a RouterOS device and manage device files (rest/native/sftp). |
| [`terminal`](#terminal) | Open an interactive RouterOS console (ssh or mac-telnet). |
| [`devices`](#devices) | Inspect and mutate the CDB-backed device registry. `devices` is the only command that writes the CDB. |
| [`discover`](#discover) | Discover RouterOS neighbors over MNDP and optionally save them into the CDB. |
| [`btest`](#btest) | Run MikroTik's bandwidth test as a client or server (peer measurement). |
| [`mcp`](#mcp) | Start the centrs MCP server (stdio) — scoped RouterOS tools gated by the CDB allowlist. |
| [`settings`](#settings) | Manage centrs's own global preferences (`centrs.env`) and inspect the `__default__` CDB record. |

## retrieve

Read RouterOS values through the shared core using the selected protocol.

```text
Usage: centrs retrieve <target> <routeros-path> [flags] | centrs retrieve <target...> <routeros-path> [flags] | centrs retrieve --group <name> <routeros-path> [flags]
```

| Flag | Value | Description |
| ---- | ----- | ----------- |
| `--via` | `<protocol>` | Pin the protocol selector. Defaults to `rest-api` for retrieve. |
| `--group` | `<name>` | Fan out across every CDB record in the group (repeatable; de-duped by record index). |
| `--where` | `<attr>=<value>` | Device-class selector over CDB facts + core fields (repeatable, AND-combined). |
| `--near` | `<lat>,<lon>,<radius>` | Geo selector: devices whose GPS is within radius (m/km/mi/ft; bare number = km). Lat-first. |
| `--bbox` | `<south>,<west>,<north>,<east>` | Geo selector: devices whose GPS is inside the lat-first bounding box. |
| `--all` |  | Fan out across every CDB record (excludes `__default__`). |
| `--default` |  | Select the reserved `__default__` record. |
| `--quickchr` | `<name>` | Target a running quickchr-managed CHR VM by name (repeatable; fans out when repeated). Exclusive of positional targets and CDB selectors; conflicts with direct connection overrides (--host/--port/--username/--password, and --ssh-key where the command has it). |
| `--concurrency` | `<n>` | Max in-flight targets during fan-out (transport-aware default: rest-api 8, native-api 4). |
| `--host` | `<host\|url>` | Override the resolved host or base URL for the target. |
| `--port` | `<port>` | Override the resolved management port. |
| `--username / --user / -u` | `<name>` | RouterOS username (aliases `--user`, `-u`). Falls back to `CENTRS_USERNAME`. |
| `--password` | `<secret>` | RouterOS password. Falls back to `CENTRS_PASSWORD`. |
| `--timeout` | `<ms\|5s>` | Operation timeout. REST currently rejects values above 60s. |
| `--attribute` | `<name>` | Project one attribute. May be repeated. |
| `--attributes` | `<a,b>` | Project a comma-separated attribute list. |
| `--all-attributes` |  | Request the RouterOS detail/all-attributes shape. |
| `--list-attributes / --list` |  | List inspect-derived attributes without running the data call. |
| `--query / --filter` | `<expr>` | RouterOS-side row filter (maps to `.query`). Not implemented yet — returns `validation/not-implemented`. |
| `--format` | `<text\|json\|yaml>` | Output format for the CLI response. Defaults to text; use --json or --format json for the structured envelope. |
| `--json` |  | Shortcut for `--format json`. |
| `--max-results` | `<bytes>` | Fail instead of printing output larger than the given byte budget. |
| `--cdb-file` | `<path>` | Read target credentials from a WinBox CDB file. |
| `--cdb-password` | `<password>` | Decrypt an encrypted WinBox CDB file. |
| `--resolve` | `<none\|arp>` | Resolve a MAC-address target to an IP via the host ARP cache (default none). |
| `--validate / --no-validate` |  | Enable or disable inspect-backed preflight validation. |
| `--verbose` |  | Show resolved setting sources in text output. |

## execute

Run a RouterOS read or write command via native API, REST, or mac-telnet.

```text
Usage: centrs execute <target> <command> [flags] | centrs execute <target...> -- <command> [flags] | centrs execute --group <name> <command> [flags]
```

| Flag | Value | Description |
| ---- | ----- | ----------- |
| `--via` | `<native-api\|rest-api\|mac-telnet>` | Pin the protocol selector; no silent downgrade when set. A bare MAC target defaults to mac-telnet. |
| `--group` | `<name>` | Fan out across every CDB record in the group (repeatable; de-duped by record index). |
| `--where` | `<attr>=<value>` | Device-class selector over CDB facts + core fields (repeatable, AND-combined). |
| `--near` | `<lat>,<lon>,<radius>` | Geo selector: devices whose GPS is within radius (m/km/mi/ft; bare number = km). Lat-first. |
| `--bbox` | `<south>,<west>,<north>,<east>` | Geo selector: devices whose GPS is inside the lat-first bounding box. |
| `--all` |  | Fan out across every CDB record (excludes `__default__`). |
| `--default` |  | Select the reserved `__default__` record. |
| `--quickchr` | `<name>` | Target a running quickchr-managed CHR VM by name (repeatable; fans out when repeated). Exclusive of positional targets and CDB selectors; conflicts with direct connection overrides (--host/--port/--username/--password, and --ssh-key where the command has it). |
| `--concurrency` | `<n>` | Max in-flight targets during fan-out (transport-aware default: rest-api 8, native-api 4). |
| `--host` | `<host\|url>` | Override the resolved host or base URL for the target. |
| `--port` | `<port>` | Override the resolved management port. |
| `--username / --user / -u` | `<name>` | RouterOS username (aliases `--user`, `-u`). Falls back to `CENTRS_USERNAME`. |
| `--password` | `<secret>` | RouterOS password. Falls back to `CENTRS_PASSWORD`. |
| `--ssh-key` | `<path>` | `--via ssh`: explicit private-key path. Falls back to `CENTRS_SSH_KEY` / the `ssh-agent`. |
| `--insecure` |  | Disable SSH host-key verification (`--via ssh`: accepts changed/impersonated keys, not just new) or accept a self-signed `api-ssl` TLS cert. Default verifies. |
| `--cdb-file` | `<path>` | Read target credentials from a WinBox CDB file. |
| `--cdb-password` | `<password>` | Decrypt an encrypted WinBox CDB file. |
| `--resolve` | `<none\|arp>` | Resolve a MAC-address target to an IP via the host ARP cache (default none). |
| `--timeout` | `<duration>` | Per-request timeout (for REST, max 60s). |
| `--validate / --no-validate` |  | Run RouterOS :parse and /console/inspect validation before execution (default true; `--validate=false` also accepted). |
| `--yes` |  | Confirm write-shaped add/set/remove commands in non-interactive runs. |
| `--max-results` | `<bytes>` | Fail if the rendered envelope exceeds this byte budget. |
| `--format` | `<text\|json\|yaml>` | Output format for the CLI response. Defaults to text; use --json or --format json for the structured envelope. |
| `--json` |  | Shortcut for `--format json`. |
| `--verbose` |  | Include additional context in text output. |
| `--` |  | End centrs option parsing: every following token is the literal RouterOS command, even flag-shaped ones (e.g. `-- /interface print where disabled=yes`). |

## api

Structured RouterOS API passthrough (gh-api style) over REST or native API.

```text
Usage: centrs api <router> <endpoint> [flags]
```

| Flag | Value | Description |
| ---- | ----- | ----------- |
| `-X / --method` | `<verb>` | HTTP method, default GET (case-insensitive). GET→print, PUT→add, PATCH→set, DELETE→remove, POST→run. |
| `-f / --field` | `<key=value>` | Body field, repeatable; assembled into the JSON body (verbatim string values). |
| `-d / --data` | `<json>` | Raw JSON request body. Conflicts with `-f` / `--input`. |
| `--input` | `<file\|->` | Read the raw JSON body from a file or stdin (`-`). |
| `--query / --filter` | `<expr>` | RouterOS-side row filter, AND-combined, repeatable: name=value, name!=value, name>value, name<value, name. |
| `--raw-query` | `<word>` | Verbatim RouterOS query word (repeatable) for OR / absence / stack expressions. |
| `--attribute / --proplist` | `<a,b>` | Property projection → `.proplist`. |
| `--raw` |  | Strip the envelope; emit bare RouterOS JSON. Implies `--validate=false`; does not imply `--yes`. |
| `--yes` |  | Confirm a mutating (non-read) request in non-interactive runs. |
| `--stream / --listen` |  | Follow changes as an NDJSON envelope stream (native-api only; the `/listen` endpoint infers it). Ends with a summary envelope. |
| `--count` | `<n>` | Stop a `--stream` after N change frames. |
| `--duration` | `<dur>` | Stop a `--stream` after this wall-clock window (e.g. `5s`). |
| `--via` | `<rest-api\|native-api>` | Pin the transport; no silent downgrade. Default rest-api. |
| `--group` | `<name>` | Fan out across every CDB record in the group (repeatable; de-duped by record index). |
| `--where` | `<attr>=<value>` | Device-class selector over CDB facts + core fields (repeatable, AND-combined). |
| `--near` | `<lat>,<lon>,<radius>` | Geo selector: devices whose GPS is within radius (m/km/mi/ft; bare number = km). Lat-first. |
| `--bbox` | `<south>,<west>,<north>,<east>` | Geo selector: devices whose GPS is inside the lat-first bounding box. |
| `--all` |  | Fan out across every CDB record (excludes `__default__`). |
| `--default` |  | Select the reserved `__default__` record. |
| `--quickchr` | `<name>` | Target a running quickchr-managed CHR VM by name (repeatable; fans out when repeated). Exclusive of positional targets and CDB selectors; conflicts with direct connection overrides (--host/--port/--username/--password, and --ssh-key where the command has it). |
| `--concurrency` | `<n>` | Max in-flight targets during fan-out (transport-aware default: rest-api 8, native-api 4). |
| `--host` | `<host\|url>` | Override the resolved host or base URL for the target. |
| `--port` | `<port>` | Override the resolved management port. |
| `--username / --user / -u` | `<name>` | RouterOS username. Falls back to `CENTRS_USERNAME`. |
| `--password` | `<secret>` | RouterOS password. Falls back to `CENTRS_PASSWORD`. |
| `--insecure` |  | Accept a self-signed `api-ssl`/REST TLS cert. Default verifies. |
| `--cdb-file` | `<path>` | Read target credentials from a WinBox CDB file. |
| `--cdb-password` | `<password>` | Decrypt an encrypted WinBox CDB file. |
| `--resolve` | `<none\|arp>` | Resolve a MAC-address target to an IP via the host ARP cache (default none). |
| `--timeout` | `<duration>` | Per-request timeout (for REST, max 60s). |
| `--validate / --no-validate` |  | Run `/console/inspect` validation before the request (default true; `--validate=false` also accepted). |
| `--format` | `<json\|yaml\|text>` | Output format. Defaults to json for api; `CENTRS_FORMAT` overrides. |
| `--json` |  | Shortcut for `--format json`. |
| `--verbose` |  | Include additional context in text output. |

## transfer

Copy files to/from a RouterOS device and manage device files (rest/native/sftp).

```text
Usage: centrs transfer <router> upload <local> [remote] | download <remote> [local] | list [path] | remove <remote> | mkdir <remote> | copy <src> <dst> [flags]
```

| Flag | Value | Description |
| ---- | ----- | ----------- |
| `--via` | `<method>` | Pin the method: rest, native, or sftp (large transfers); scp/fetch/ftp are not built yet. Auto picks the cheapest by size/direction. |
| `--ssh-key` | `<path>` | sftp only: explicit private-key path. Falls back to CENTRS_SSH_KEY / the ssh-agent. |
| `--insecure` |  | Accept a self-signed TLS cert (https/api-ssl) or a new SSH host key. Default verifies. |
| `--force / --overwrite` |  | Replace an existing destination. Default refuses it. |
| `--group` | `<name>` | Fan out across every CDB record in the group (repeatable; de-duped by record index). |
| `--where` | `<attr>=<value>` | Device-class selector over CDB facts + core fields (repeatable, AND-combined). |
| `--near` | `<lat>,<lon>,<radius>` | Geo selector: devices whose GPS is within radius (m/km/mi/ft; bare number = km). Lat-first. |
| `--bbox` | `<south>,<west>,<north>,<east>` | Geo selector: devices whose GPS is inside the lat-first bounding box. |
| `--all` |  | Fan out across every CDB record (excludes `__default__`). |
| `--default` |  | Select the reserved `__default__` record. |
| `--quickchr` | `<name>` | Target a running quickchr-managed CHR VM by name (repeatable; fans out when repeated). Exclusive of positional targets and CDB selectors; conflicts with direct connection overrides (--host/--port/--username/--password, and --ssh-key where the command has it). |
| `--concurrency` | `<n>` | Max in-flight targets during fan-out (transport-aware default: rest-api 8, native-api 4). |
| `--out-dir` | `<dir>` | `download` fan-out only: write one file per target into `<dir>`, named by CDB identity. Required when downloading across a selection. |
| `--yes` |  | Confirm a mutating fan-out (upload/remove/mkdir/copy) across multiple routers in non-interactive runs. |
| `--verify / --no-verify` | `<size\|checksum\|off>` | Post-transfer integrity check. Default size; `--no-verify` skips. |
| `--type` | `<file\|directory\|disk\|package>` | list filter: RouterOS /file row type. |
| `--name` | `<glob>` | list filter: file-name glob. |
| `--host` | `<host\|url>` | Override the resolved host or base URL. |
| `--port` | `<port>` | Override the resolved management port. |
| `--username / --user / -u` | `<name>` | RouterOS username (aliases --user, -u). Falls back to CENTRS_USERNAME. |
| `--password` | `<secret>` | RouterOS password. Falls back to CENTRS_PASSWORD. |
| `--timeout` | `<ms\|5s>` | Operation timeout. REST rejects values above 60s. |
| `--format` | `<text\|json\|yaml>` | Output format. Defaults to text; --json / --yaml shortcuts. |
| `--json` |  | Shortcut for --format json. |
| `--yaml` |  | Shortcut for --format yaml. |
| `--cdb-file` | `<path>` | Read target credentials from a WinBox CDB file. |
| `--cdb-password` | `<password>` | Decrypt an encrypted WinBox CDB file. |
| `--validate / --no-validate` |  | Enable or disable the existence-probe preflight. |
| `--verbose` |  | Show the resolved transport in text output. |

## terminal

Open an interactive RouterOS console (ssh or mac-telnet).

```text
Usage: centrs terminal <router> [flags]
```

| Flag | Value | Description |
| ---- | ----- | ----------- |
| `--via` | `<method>` | Transport: `ssh` (host target, default) or `mac-telnet` (MAC target, default for a MAC). rest/native have no terminal capability. |
| `--host` | `<host>` | Override the target host (ssh) / UDP delivery host (mac-telnet, default L2 broadcast). |
| `--port` | `<port>` | Override the port: ssh default 22, mac-telnet default 20561. |
| `--username / --user / -u` | `<name>` | RouterOS username (aliases --user, -u). Falls back to CENTRS_USERNAME. |
| `--password` | `<secret>` | RouterOS password. Falls back to CENTRS_PASSWORD. |
| `--source-mac` | `<mac>` | mac-telnet: explicit in-packet source MAC (overrides egress resolution). |
| `--ssh-key` | `<path>` | `--via ssh`: explicit private-key path. Falls back to `CENTRS_SSH_KEY` / the `ssh-agent`. |
| `--insecure` |  | `--via ssh`: disable host-key verification (accepts changed/impersonated keys). Default verifies. |
| `--cdb-file` | `<path>` | Read target credentials from a WinBox CDB file. |
| `--cdb-password` | `<password>` | Decrypt an encrypted WinBox CDB file. |
| `--resolve` | `<none\|arp>` | `--via ssh` only: turn a MAC target into an IP. CDB-first; `arp` opts into the host ARP cache (default none). The mac-telnet default ignores it. |
| `--format` | `<text\|json\|yaml>` | Error-envelope format on failure. --json / --yaml shortcuts. |
| `--json` |  | Shortcut for --format json. |
| `--yaml` |  | Shortcut for --format yaml. |
| `--verbose` |  | Verbose error output. |

## devices

Inspect and mutate the CDB-backed device registry. `devices` is the only command that writes the CDB.

```text
Usage: centrs devices <list|show|groups|add|edit|set|remove> [args] [flags]
```

| Flag | Value | Description |
| ---- | ----- | ----------- |
| `--cdb-file` | `<path>` | Override the resolved CDB path (default `~/.config/tikoci/winbox.cdb`). |
| `--cdb-password` | `<secret>` | Decrypt an encrypted CDB. Falls back to `CENTRS_CDB_PASSWORD`. Also used to re-encrypt on writes. |
| `--via` | `<protocol>` | Resolve and report the protocol source for provenance examples; no network IO is performed. |
| `--group` | `<name>` | `list` filter / `add`,`edit` first-class group field for the target entry. |
| `--where` | `<attr=value>` | `list` only — repeatable device-class filter over CDB facts (AND-combined), e.g. `--where lat=37.7749`. |
| `--near` | `<lat>,<lon>,<radius>` | `list` only — GPS filter: devices within radius (m/km/mi/ft; bare number = km). Lat-first. |
| `--bbox` | `<south>,<west>,<north>,<east>` | `list` only — GPS filter: devices inside the lat-first bounding box. |
| `--members` |  | `groups` only — expand each group's membership. |
| `--explain` |  | `show` only — include the raw `WinBoxCdbRecord` in `data.record`. |
| `--match` | `<user=…\|target=…\|record-type>` | `show` — disambiguate when `<router>` matches several records: `user=<name>`, `target=<addr>`, or a record-type token. |
| `--user` | `<name>` | `add`,`set` — first-class CDB user field. |
| `--password` | `<secret>` | `add`,`set` — first-class CDB password field. |
| `--profile` | `<name>` | `add`,`set` — named WinBox profile (Workspace). |
| `--profile-none` |  | `add`,`set` — write the WinBox `<none>` profile sentinel. |
| `--profile-own` |  | `add`,`set` — write the WinBox `<own>` profile sentinel. |
| `--session` | `<name>` | `add`,`set` — first-class CDB session field. |
| `--comment` | `<text>` | `add` only — base free-form comment (may include kv-soup). |
| `--record-type` | `<macTarget\|ipAdmin\|ipUser\|romonNeighbor\|romonTarget>` | `add` only — record type (default `ipAdmin`). |
| `--lat / --latitude` | `<deg>` | `add`,`set` — latitude in decimal degrees (-90..90); a comment-kv fact, paired with --lon. |
| `--lon / --lng / --longitude / --long` | `<deg>` | `add`,`set` — longitude in decimal degrees (-180..180); a comment-kv fact, paired with --lat. |
| `--altitude / --alt / --ele / --elevation` | `<meters>` | `add`,`set` — altitude in meters (may be negative); a comment-kv fact. |
| `--altitude-type / --alt-type` | `<MSL\|AGL>` | `add`,`set` — vertical datum for --altitude (default MSL); case-insensitive. |
| `--gps` | `<lat>,<lon>[,<altitude>[,<altitude-type>]]` | `add`,`set` — combined lat,lon[,altitude[,altitude-type]] convenience (lat-first; missing altitude-type defaults MSL). |
| `--force` |  | `add` only — overwrite the existing (target, user) entry. |
| `--strict` |  | `add`,`set` — reject unknown comment kv keys instead of warning. |
| `--format` | `<text\|json\|yaml>` | Output format for the CLI response. |
| `--json` |  | Shortcut for `--format json`. |

## discover

Discover RouterOS neighbors over MNDP and optionally save them into the CDB.

```text
Usage: centrs discover [--timeout 15s] [--save] [flags]
```

| Flag | Value | Description |
| ---- | ----- | ----------- |
| `--timeout` | `<ms\|15s>` | Listen window before results are returned. Default 15s. |
| `--save` |  | Persist discovered neighbors into the CDB (`group=discovered`, `source=mndp`). |
| `--group` | `<name>` | `--save` group for new entries. Default `discovered`. |
| `--port` | `<port>` | UDP port to bind for MNDP. Default 5678. |
| `--cdb-file` | `<path>` | `--save` CDB path override (default `~/.config/tikoci/winbox.cdb`). |
| `--cdb-password` | `<secret>` | `--save` password for an encrypted CDB. Used to decrypt the existing CDB and re-encrypt on write. |
| `--format` | `<text\|json\|yaml>` | Output format for the CLI response. |
| `--json` |  | Shortcut for `--format json`. |

## btest

Run MikroTik's bandwidth test as a client or server (peer measurement).

```text
Usage: centrs btest <client <router>|server> [flags]
```

| Flag | Value | Description |
| ---- | ----- | ----------- |
| `--protocol` | `<udp\|tcp>` | (client) Transport. Default udp. |
| `--direction` | `<receive\|transmit\|both>` | (client) Test direction. Default receive. |
| `--duration` | `<dur>` | Bound the run (e.g. 15s). Omit for open-ended (Ctrl-C). |
| `--interval` | `<dur>` | Report cadence (20ms..5s). Default 1s. |
| `--connection-count` | `<n>` | (client, TCP only) Parallel TCP data connections (1..255). |
| `--local-udp-tx-size` | `<n>` | (client, UDP only) Client→server packet size (28..64000). |
| `--remote-udp-tx-size` | `<n>` | (client, UDP only) Server→client packet size (28..64000). |
| `--local-tx-speed` | `<bps>` | (client) Cap on client→server rate (e.g. 100M). |
| `--remote-tx-speed` | `<bps>` | (client) Cap on server→client rate (e.g. 100M). |
| `--random-data` |  | (client) Incompressible payload. |
| `--nat-mode` |  | (client, UDP only) Originate an outbound datagram first so server→client data can traverse NAT. Automatic when the test receives. |
| `--authenticate / --no-authenticate` |  | (server) Require EC-SRP5 auth. Default true; `--authenticate=false` also accepted. |
| `--bind` | `<addr>` | (server) Listen address. Default 127.0.0.1. |
| `--allocate-udp-ports-from` | `<n>` | (server) Base of the UDP data-port range. Default 2001. |
| `--max-sessions` | `<n>` | (server) Concurrent test cap (1..1000). Default 100. |
| `--user / --username / -u` | `<name>` | Credential (aliases --username, -u; falls back to CDB / CENTRS_USERNAME). |
| `--password` | `<secret>` | Credential (falls back to CDB / CENTRS_PASSWORD). |
| `--port` | `<port>` | Control port. Default 2000. |
| `--cdb-file` | `<path>` | (client) Read target credentials from a WinBox CDB file. |
| `--cdb-password` | `<password>` | (client) Decrypt an encrypted WinBox CDB file. |
| `--format` | `<text\|csv\|json\|yaml>` | Output format. Default text. |
| `--csv` |  | Shortcut for `--format csv`. |

## mcp

Start the centrs MCP server (stdio) — scoped RouterOS tools gated by the CDB allowlist.

```text
Usage: centrs mcp [start] [--cdb-file <path>] [--allow-adhoc-targets]
```

| Flag | Value | Description |
| ---- | ----- | ----------- |
| `--cdb-file` | `<path>` | CDB allowlist path (default `~/.config/tikoci/winbox.cdb`, or CENTRS_CDB_FILE). |
| `--cdb-password` | `<password>` | Decrypt password for an encrypted CDB (or CENTRS_CDB_PASSWORD). |
| `--allow-adhoc-targets` |  | Reserved unsafe escape hatch for future inline targets; current tools still use CDB-only targets. |
| `--help` |  | Show this help. |

## settings

Manage centrs's own global preferences (`centrs.env`) and inspect the `__default__` CDB record.

```text
Usage: centrs settings [print|get|set|reset] [args] [flags]
```

| Flag | Value | Description |
| ---- | ----- | ----------- |
| `--all` |  | `print` only — also list unrecognized CENTRS_* lines found in the file. |
| `--cdb-file` | `<path>` | `print` only — CDB to probe for the `__default__` record summary (falls back to normal CDB resolution; never centrs.env). |
| `--cdb-password` | `<secret>` | `print` only — decrypt password for the probed CDB. |
| `--skip-env-file` |  | `print` only — note that other commands in this environment would not see centrs.env (settings itself always reads the real file). |
| `--format` | `<text\|json\|yaml>` | Output format for the CLI response. |
| `--json` |  | Shortcut for `--format json`. |
| `--help` |  | Show this help. |
