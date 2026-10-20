# Changelog

All notable changes to this repository should be recorded here.

The product evolves as a stream of changes; there are no alpha gates.
Per-feature status is tracked in `docs/MATRIX.md`. Use this file for
documenting cross-cutting shifts that affect contributors and consumers.

Each stable version has one section. Work in progress goes under
`## X.Y.Z — next`, which is what `@next` installs (`X.Y.Z-next.N`); the stable
release dates that heading. A `-next.N` build has no section of its own.

## 0.1.9 — next

In progress on npm tag `next`. The `0.1.9-next.0` cut (2026-10-13) carried
part of this section.

### Added

- **Live `explain` over rest-api + native-api is `CHR-passed`** (#236).
  Examples 7–16, 19, 24, 48 and 52–53 pass on both transports on stable
  7.24.5 and long-term 7.23.8. `runtimeAcceptance` stays `not-proven`.
- `explain <router> '<input>'` and `explainLiveEnvelope()` add read-only parse,
  highlight and command-argument evidence over REST/native API. Probe outcomes,
  byte coverage and provenance remain explicit; analyzed input never executes (#491).
- Live `explain` fills the two live value facts (#225). `observedType` names a
  type only where the device visibly converts a bare scripting literal
  (`2.2` → `2.0.0.2` is `ip`, `0x10` → `16` is `num`), read from an escaped
  `:parse` of the literal alone; an unchanged rendering abstains, and no
  `:typeof` is sent. `schemaType` normalizes the argument's live `syntax`
  declaration into leaf types (`gateway` → `ip`, `ip6`, `enum`), with the
  device's own term in `declared`. Menu arguments are never observed, and
  `op` has no producer.
- Live `explain --schema` describes the path at the cursor: a menu's verbs and
  submenus with counts, a command's arguments with their declared syntax, and
  `print`'s proplist. `--complete [--cursor <byte>]` returns menu, verb,
  argument-name, `where` variable or value candidates. They are the device's
  own input completion at the cursor, cited by `ev`; declared names and
  syntax stay in `--schema`. `--full` lifts the sizing limits up to a safety
  ceiling.
  Only probe shapes that answer on RouterOS 7.12.2 and 7.20.8 are sent (#492).

- `centrs --version` / `-V` prints the package version alone; `--json` (or
  `--format json|yaml`) returns an envelope with `data.version` (#463).
- `execute --cmr` warns `cmr/caller-policy-not-enforced` when a write runs
  through a controller login that lacks `write`, `test` or `reboot`. On
  7.26beta1 RouterOS runs the client script with all four anyway, so the
  login is not the limit (#456). MikroTik says 7.26beta2 refuses this for a
  `read` group. The warning is also in the confirmation
  error. centrs reads the login's own `/user` row and group once, only for a
  write; a failed read only loses the warning.
- The write gate of a CMR controller fleet command run with plain `execute` or
  `api` names the devices it reaches (#453). `/cmr/device/reboot labels=all`
  used to read as one router; centrs now reads the controller's `/cmr/device`
  inventory first and says, for example, "2 CMR device(s) through controller
  ctl, the controller itself among them" (`error.context.cmr`). The covered commands are
  `/cmr/device/{reboot,upgrade,pair,run-script}`, `/cmr/upgrade/trigger` and
  rule changes on `/cmr/vlan`, `/cmr/wifi`, `/cmr/wifi/radio` and
  `/cmr/upgrade`. New warnings, with or without `--yes`:
  `cmr/selection-includes-controller` and `cmr/rule-selects-every-device`
  (a VLAN rule with no `labels` and no `port-labels` cuts the fleet's
  management access). `cmr/empty-selection` is also a warning here.
  `run-script` and `reboot` carry `cmr/caller-policy-not-enforced` as
  `execute --cmr` does. The command still runs as typed, and a failed read
  never blocks it.

- `execute <controller> --cmr --labels <expr> -- '<command>'` runs one
  validated command on CMR clients through their controller (RouterOS
  7.26beta1+; #450, #451). Only the controller is dialed, with its own
  credentials. Each selected client validates the command with `:parse`
  first, and a client whose answer is incomplete or rejected is not sent it.
  The command then goes to each client in its own `run-script` call, bound to
  the `/cmr/device` row and key it was validated on, and is never retried; a
  timeout, cancellation or lost call is `cmr/outcome-unknown`. One `--yes`
  covers the whole selection. Native API (default) and REST to the controller
  are both CHR-tested. Raw `run-script` through `api` or plain `execute` warns
  `cmr/client-script-not-validated`. Not on MCP yet.
- `cmr/policy-denied`: a statement CMR scripts may not run (`/user add`,
  `/tool sniffer`: the client allows only `read`, `write`, `test` and
  `reboot`) is reported as such instead of a generic RouterOS failure, also
  after earlier output. `:parse` accepts these commands, so validation cannot
  catch them, and statements before the refused one have already run.
- `cmr/console-only`: `execute` and `api` refuse `/cmr/device/dashboard`. A
  plain path is refused before dialing; any other spelling (a relative menu
  change, a block, an `/execute` script) is found in the controller's `:parse`
  return. On 7.26beta1 it closed a native API session, and over REST it held
  the controller's REST service for every caller for 10–30 s.
- `execute --cmr` against a router with no `/cmr/device` says why. RouterOS
  older than 7.26beta1 (CMR is beta-only) is `routeros/version-unsupported`
  with `capability: cmr-controller`. A 7.26beta1+ router without the `cmr`
  package stays `cmr/not-a-controller`, now naming its version and, for a CMR
  client, its controller.
- `execute --cmr` accepts a command that opens with a relative menu change
  (`/system; identity/print`); its `:parse` return was read as incomplete.

### Changed

- **`meta.validation` success shapes (#535).** This is a breaking change for
  `--json` readers of the flat fields. `syntax` and `semantic` are now present
  only when a gate stage gave that verdict; absent means no stage was asked.
  - `api` structured requests (no `:parse`) drop `syntax: false`.
  - Script input drops `semantic: "not-applicable"`; the value is gone from
    the type.
  - `--validate=false` drops both fields on `execute` and `api`.
  - `retrieve`, `transfer` and `api` structured successes now report
    `stages[]`.
  - `explain` reports `meta.validation: { enabled: false }` with no `result`
    in all three cases (offline, live, error); it is not a gate.
- Text stdout is data (#470). In text mode, single-target `execute`, `api`,
  `retrieve` and `transfer` write only the result to stdout. Everything else
  goes to **stderr** on success and on failure: the `--verbose` header, one
  `warning [<code>]: <message>` line per warning, and the `Tips:` footer.
  Plain `execute` and `api` used to drop warnings and envelope tips, so a
  `--yes` write never showed, for example, `cmr/rule-selects-every-device` or
  `transport/write-outcome-unknown`. `retrieve` and `transfer` used to mix
  them into stdout. `transport/provider-trust` stays out of text output.
  `--json` keeps everything, `api --raw` is unchanged, and fan-out text still
  lists warnings in its report.
- **Breaking:** shared meta is written once (#461, #462). In a fan-out
  envelope, each target's `meta.settings` keeps only the keys whose source differs from the
  outer `meta.settings`. Its `meta.operation` drops `request` and `auth` when
  they equal the outer operation's. When every target agrees on `auth`, or on
  a setting the outer `meta.settings` lacks (`api` and `transfer` had none), it
  moves to the outer envelope. An `execute --cmr` member no longer
  repeats the controller in `meta.target.cmr`, because the outer `meta.target`
  is the controller. A 3-client `execute --cmr` result went from 9.8 KB to
  5.4 KB. `expandFanoutTarget()` returns a target's full meta. A
  `retrieve --follow` frame now carries only `meta.operation`;
  `started`, `synced` and the summary still carry the full meta. A frame line
  went from about 1.15 KB to 270 bytes.
- **Breaking:** all three streams (`retrieve --follow`, `retrieve --sample`,
  `api --stream`) open with a full-meta `started` line (`data: null`), replacing
  `notice` where it was emitted (#473, #480). Advice is in its `tips`. Only
  `meta.operation` remains on each `frame` or `sample`; the full meta stays
  on `started`, `summary`, and follow's `synced`. Consumers must handle
  `started` and read shared meta from those lines. `apiStream()` now yields
  `ApiStreamLine`, and `retrieveSample()` yields `RetrieveStreamLine`;
  `ApiStreamFrameEnvelope`, `StreamLineEnvelope` and `isStreamDataLine` are
  exported for consumers. API frames also gain `observedAt` (host receipt
  time, ISO 8601). In text mode only frame/sample rows go to stdout; status
  lines, tips, warnings and errors go to stderr. Structured formats keep
  every line on stdout, and `api --raw` omits `started`.
- `retrieve --follow` frames carry `observedAt` (ISO 8601, host clock): when
  centrs received the reply the frame is built from (#462).
- With `--query`, a removal the follow's sweep finds is `source: "sweep"`,
  as documented; it was labelled `membership` (#462).
- An empty selection is an error for a write: `execute`, mutating `api` and
  `transfer upload|remove|mkdir|copy` fan-outs (`cdb/empty-group`,
  `cdb/empty-selection`) and `execute --cmr` (`cmr/empty-selection`) now exit 1
  with `ok: false`, with or without `--yes`. A mistyped group or label passed
  for a successful bulk write with exit 0 (#460). A read over an empty
  selection is unchanged: `ok: true` with the warning.
- The write gate treats pure script functions as reads, so a structured read
  such as `:put [:serialize to=json [/system/resource/print as-value]]` no
  longer needs `--yes` (#458). The added directives are `:serialize`,
  `:deserialize`, `:convert`, `:delay`, `:find`, `:timestamp`, `:jobname`,
  `:nothing`, `:range`, `:rndnum`, `:rndstr`, `:retry`, `:time` and the `:to*`
  converters, all from the grounded root-command vocabulary. Commands inside
  their arguments and `{…}` bodies are still checked; on CHR 7.24.5 and
  7.26beta1, RouterOS refuses a quoted string as a script body. `file-name=`
  (`:serialize`'s output file) now gates like `file=`. `api POST
  /console/inspect` is a read.
- CMR fleet commands (`/cmr/device/{run-script,reboot,upgrade,pair}`,
  `/cmr/upgrade/trigger`, `/cmr/upgrade/job/run-next`) are pinned as writes in
  every spelling, over `execute`, `api` and MCP `mcp=ro`. On 7.26beta1 a
  controller login with only `read` + `api` can run them (#456).
- CI, release, Pages and the Docker image run Bun 1.4.2 (was 1.3.14), the
  version local development already used; `@types/bun` moves with it (#438).
  `engines.bun` stays `>=1.3.11 <2`. The `typescript` peer stays `^6.0.3`:
  the source passes `tsc --noEmit` under TypeScript 7.0.2, but typedoc 0.28 (the
  API reference build) supports TypeScript up to 6.0.x only.
- QA records a CHR leg in `qa-history` only when its test step passed or
  failed. A leg cancelled by a newer push, or skipped after a setup failure,
  was recorded as `fail` (#442).
- CHR integration runs prefetch their selected image before tests start,
  including direct file runs, so a cold-cache download does not consume a
  test timeout. `bun run chr:prefetch` is the explicit entry point (#468).
- A centrs flag written after `--` is refused before anything dials, as
  `usage/flag-after-separator`, with the corrected command line (#459). This
  applies to `execute` (including `--cmr`) and `explain`. Before, a trailing
  `--json` was sent to RouterOS and failed there as `unknown-attribute`. Only
  a command's own long flags are matched (short aliases such as `-u` stay
  RouterOS input), and password values are not echoed.

### Fixed

- `retrieve --sample`, `--follow` and `--wait` no longer report a validation
  verdict the gate never gave (#537). A cancellation before the gate ran now
  reports the device stage `not reached` (`interrupted` for `--sample` and
  `--follow`, `wait/interrupted` for `--wait`) instead of
  `{enabled: true, result: "skipped"}`. A `--wait` cancelled after retried,
  unanswered attempts no longer reports `result: "failed"`. With validation
  off, all three report `{enabled: false, source: "disabled"}`.
- Abbreviated output-file arguments (`fi=`, `file-n=`), and the spaced
  `file-name value` form under print/export/serialize, require write
  confirmation in `execute`, including inside scripts, and are refused for
  MCP `mcp=ro` records. RouterOS accepted these spellings while centrs
  recognized only `file=` and `file-name=`, letting file creation bypass
  both gates.
- The suggested command in `usage/flag-after-separator` redacts credentials
  in positional targets and `--host` values, including a host flag moved
  before `--` and percent-encoded URL credentials. Inline value flags keep their
  flag names in the correction. This closes error-path gaps in the target
  redaction below; explicit URL credentials are refused before CDB lookup too.
- Serialized error causes keep `name`, `message` and `code` and omit raw JS
  stack traces and their local installation paths (#476, #480).
- A target with credentials in it (`http://admin:pass@host`, `admin:pass@host`,
  `admin@host`) is refused with `input/invalid-target`, which names
  `--username` and `--password` (#478). centrs never used those credentials,
  and it echoed the whole string, password included, in `meta.target.input`,
  the fan-out selection and the `--verbose` header. The refusal covers the
  positional, `--host`, `CENTRS_HOST`, CDB targets and fan-out literals, and
  any displayed target has `user:pass@` replaced by `***@`, even when the
  password holds `/`, `?` or `#`. A CDB identity containing `@` (`rtr@site`)
  still resolves.

- `execute` and `api` never replay a write that was sent (#448). Fan-out
  retried every `transport/network` and `transport/connection-closed` failure
  up to twice, so a write whose connection dropped after the router had run
  it could be applied up to three times. A write is now retried only when one
  of those failures came before it was sent, for example during validation or
  a native API login. A write that failed after it was sent, in single-target
  or fan-out mode, carries the new warning `transport/write-outcome-unknown`,
  because it may have run. Reads keep the retry.

### Maintenance

- Releases are one dispatch from `main` (#484, #485). `@next` publishes
  `X.Y.Z-next.<run_number>` with no commit, PR or tag, and reuses main's QA
  run on the commit instead of sweeping every channel again. `@latest` creates
  the tag and a GitHub Release. A pushed `v*` tag no longer publishes. The
  changelog keeps one section per stable version; the `0.1.8-next.0` and
  `0.1.9-next.0` sections are folded into theirs.
- The CodeQL workflow no longer runs the AI-findings probe job (#486). Code
  Quality AI findings are a paid feature this repository does not enable.
- Workflows reference actions by major tag, never by commit SHA, and
  `SECURITY.md` records why (#266). Every `setup-bun` step reads the Bun
  version from `packageManager`, so changing Bun is a one-line edit. Every
  checkout except the QA history push drops its git credentials.
- zizmor audits the workflows: in CI as `Analyze (zizmor)` in `codeql.yaml`
  (Security tab), and locally with `bun run lint:actions` (#266). Its first
  run found two `${{ … }}` expansions inside shell scripts, in `lab.yaml` and
  `qa.yaml`; both now go through `env:`.

## 0.1.8 — 2026-10-12

Most of this section first shipped as `0.1.8-next.0` (2026-10-12).

### Added

- **`retrieve --wait` establishes readiness or a condition by a deadline (#364).**
  One final envelope over REST or native API, with elapsed time, attempts and
  completed observations. `--until` uses the shared query grammar and succeeds
  on any matching selected row; `--until-empty` requires a completed zero-row
  read. Already-true conditions succeed immediately. Only transient transport
  errors retry; authentication and validation fail immediately. `--timeout`
  bounds each request, and optional `--sample` sets observation cadence.
- **`retrieve --follow` keeps a menu's rows current over native API (#396).**
  Snapshot rows, one `synced` line, then a line per change, as NDJSON; an
  `.id` sweep (`--sweep`, default 10s) reports removals RouterOS never sends
  on view menus. Single target; `--query` / `--filter` (#397) use device
  membership reads and filtered sweeps, with membership removals distinguished
  from wire deletions. `--sweep`
  needs a unit (`10s`); only `0` (off) may be bare.
- **`retrieve --sample <interval>` re-reads a menu on a timer.** One line per
  complete read (`data` is the whole read), then a summary; `--count` and
  `--duration` bound it. Works over REST and native API, on list menus and
  singletons, and sees counters `--follow` cannot. The interval needs a unit
  (`5s`): a bare number is refused because RouterOS and centrs read it
  differently.
- **`retrieve --query` filters rows on the router (#397).** Write what you
  would after `print where` (`type=ether and !disabled`, `mtu>=1500`,
  `(a=1 or b=2)`); centrs compiles it to the API query, so the router filters.
  `--filter` is the same flag; repeats are AND-ed. Property names are
  validated, and bare names are asked of the router (`disabled` → `=yes`,
  `comment` → "is set"). `~`, `in` and script values fail
  `input/unsupported-query`. Works with `--sample`, fan-out and `--follow`.
  Checked on CHR against RouterOS's own `find where`.
- `--format ndjson` for `retrieve`. Library: `retrieveFollow()`,
  `retrieveSample()`, and `renderRetrieveStreamLine()` for both (it replaces
  the unreleased `renderRetrieveFollowLine()`).

### Fixed

- `retrieve --wait` with no deadline value names `--wait` (#445). Written as a
  bare switch, `--wait --until 'expr'` read `--until` as the deadline and
  shifted the predicate into a second target, so the CLI reported
  `usage/fanout-not-supported`. It now fails `settings/invalid-timeout`
  ("Received the flag: --until"), and every deadline without a unit gets the
  `--wait`-specific message. A real multi-target `--wait` still gets the
  fanout refusal.
- MCP accepts a registered device by its `identity=`, `mac=` or `ip=` comment
  key, as the CLI does (#444). The allowlist gate now matches with the same
  resolver the call dials with, so the `mcp=` write policy checked is the
  policy of the record the call runs against. A name on more than one record
  fails `identity/ambiguous` with the candidates in `context.matches` and an
  MCP remediation, instead of resolving to the first.

- `execute` honors an explicit target URL, and native-api honors a typed port
  (#426, from #384). With no `via` pinned, an `http(s)://host[:port]` target
  selects rest-api on that scheme and port instead of silently dialing native
  API on 8728; `meta.settings.via` reports `via:target-url`. A port typed into
  the target (`host:9`, `--host`, `CENTRS_HOST`) now reaches native-api on
  every command, below the port settings (`--port`, `CENTRS_PORT`, `port=`,
  config), as it already did for ssh and REST. An explicit `:80`/`:443`, which
  URL parsing normalizes away, is kept for native-api and ssh. A matched CDB
  record's own port is unchanged. A `--quickchr` target keeps native-api
  whatever `CENTRS_HOST` holds.

- A pinned CDB no longer refuses an address it has no record for (#427, from
  #384). With `--cdb-file`, `CENTRS_CDB_FILE`, `CENTRS_CDB_PASSWORD` or a
  `centrs.env` CDB path, an IP, `[IPv6]:port`, `http(s)://` URL or MAC that
  matches no record is dialed as a literal host, as it is with no CDB. This
  holds on every command and in fan-out, where each such member also failed. A
  DNS name or identity that matches nothing still fails closed with
  `cdb/not-found-target`, and MCP still accepts only registered targets. An
  IPv6 literal now dials over native-api, ssh, terminal and btest. Before, the
  address was passed to them still in brackets (`[2001:db8::1]`) and failed to
  resolve. SFTP, which needs the brackets, keeps them. A bare IPv6 target
  (`2001:db8::1`, no port) is now accepted everywhere instead of
  `input/invalid-target`. Error messages bracket an IPv6 endpoint
  (`[2001:db8::1]:8728`).

- The `--host` flag can stand in for `<router>` (#428, from #384).
  `execute --host http://192.0.2.10:8080 '<cmd>'`, `execute --host <host> --
  <cmd>`, `retrieve --host <host> <path>`, `api --host <host> <endpoint>`,
  `transfer --host <host> <verb>` and `terminal --host <host>` (ssh) now reach
  the router instead of failing `input/invalid-command` for a missing target.
  With no `<router>` there is no CDB lookup, so auth comes from flags, env or
  config. `CENTRS_HOST` doesn't change how positionals are read. Two or more
  `execute` positionals without `--` still split as `<target> <command>`, so
  `execute <mac> <cmd> --via mac-telnet --host <udp-host>` is unchanged. The
  `upload`/`download` aliases still read their first positional as the target.

- A one-shot `retrieve` that fails after resolution keeps the resolved meta
  (#433). A refused connection, auth failure or validation error now reports
  `meta.target` (host, port, base URL, record, sources), `meta.via`,
  `meta.settings` and `meta.operation.auth`, as `execute`, `api` and `transfer`
  already did. Before, it reported `meta.via: null` and only the typed input.
  The MCP `centrs_retrieve` tool had the same gap and is fixed too. New
  library export: `retrieveEnvelope()`, which never throws.

- Error envelopes no longer report validation `failed` when the validator
  never answered or had passed (#435). A transport or auth failure (and, for
  `retrieve`, a `routeros/*` error) that stops the gate now omits
  `meta.validation.result` and the `syntax`/`semantic` summaries. Each stage
  the gate did not reach reports `skipped` with
  `reason: "not reached: <error.code>"`. `retrieve` now records the gate's
  result, so a read that fails after inspect passed reports `passed`. Success
  envelopes now carry `result: "passed"` too. `--validate=false` reports
  `{enabled: false, source: "disabled"}` instead of `result: "failed"`. Only a
  gate refusal reports `failed`. On an `execute` rejection, `syntax: true` now
  means only a name-level refusal; a `:parse` refusal (syntax, unknown path,
  missing package, unavailable menu) is `syntax: false` with no `semantic`.
  Before, every device rejection said `syntax: true`. A failure in `api`'s
  `--query` boolean probe after the gate passed now reports `passed`. Applies
  to `execute`, `api` (including `--stream`) and every `retrieve` mode. `ValidationTrace` is now a public
  type, and `retrieve()` accepts `{ trace }`. The shape is interim until the
  live-explain review (#236).

- SSH execute, SFTP and terminal add `IdentitiesOnly=yes` when a private key is
  selected, preventing fallback to unrelated SSH agent identities (#177).
  Explicit OpenSSH `IdentityFile` configuration continues to apply.

- Query QA declares the RouterOS version split for unquoted firewall `where`
  literals. Testing/development builds select rows that 7.24.5 does not;
  both API transports retain exact result checks on either side of the split.

- Fan-out FAIL rows and btest client/server CSV error comments replace terminal
  controls with spaces (#395, #415). Compact error text stays on one line,
  including target labels and verbose remediation; JSON/YAML keep the raw values.

- **`api --stream` is now a literal stream of the wire (#402).** Following a
  menu is the `<menu>/listen` endpoint (GET; implies `--stream` and
  native-api); a GET with `--stream` streams one literal print. RouterOS's
  `!empty` is no longer dropped: every reply is a frame, `reply: "re"` (a row)
  or `"empty"` (`data: null`), and one received after a local stop carries
  `afterStop: true`. `--count` counts rows only. Property lists and queries go out
  as typed; `tip/filtered-follow` and `tip/follow-proplist` say what RouterOS
  will not report, and request-shape tips lead the stream as a `notice`
  envelope. `--format ndjson` prints every envelope as one compact line,
  one-shot or streamed. **Breaking:** `--listen` and `ApiRequest.listen` are
  removed (`usage/removed-flag`, which prints the replacement command with
  values redacted); `apiListen()` is renamed `apiStream()`, and
  `ProtocolAdapter.listen()` is `stream()`.

- **`transfer` moves `/file` contents as bytes on REST and native API
  (#404).** centrs decoded and encoded file contents as UTF-8, so every
  non-UTF-8 byte became U+FFFD (a 2,842-byte file downloaded as 3,422 bytes).
  Library: `ProtocolExecuteRequest` and `NativeApiCommand` gain an opt-in
  `binary` mode; a code unit above U+00FF is refused
  (`internal/byte-string`). Every other command stays UTF-8.

- `transfer download` checks the local destination before reading the device
  (#403). A missing parent directory, a destination that is a directory, or a
  write that still fails reports the new `input/local-destination` (the OS
  error rides as `cause`) instead of `internal/unhandled` after a full read.
  Download replaces an existing local file, like `curl -o` and `scp` (#406);
  `--force` guards device destinations only, and the docs now say so.

- A `transfer` failure after resolution keeps the resolved meta (#391):
  `meta.target`, `meta.via`, `meta.settings` and `meta.operation.auth`, with
  no secret values. Batch SSH (sftp `transfer`, `execute --via ssh`) never
  sends a password, and the `auth/failed` remediation now says so and names
  the key source; `error.context.sshKeySelected` is new. When a password was
  resolved, `tip/sftp-password-not-used` and
  `tip/transfer-password-transport` explain it and suggest `--via rest` or
  `native-api`. New library export: `transferEnvelope()`, which never throws.

- `explain` reads the CLI Reference layout `manual.mikrotik.com` has served
  since 2026-10-06, and its path catalog now includes RouterOS 7.26beta1
  (#417). 47 paths are added (`/cmr/*`, `/system/dashboard`,
  `/interface/wifi/dashboard`, `/tool/apptraffic`, and others), so commands
  such as `/cmr/device/reboot` resolve instead of warning.

- **`api --query` uses the `print where` grammar too (#397).** A bare name is
  now `=yes` for a boolean (was "has the property"; that is
  `--raw-query name`), `<`/`<=` include rows without the property as `where`
  does, and a value containing an operator stays one value (`comment=a>b` was
  sent as `>comment=a=b`). With `--validate=false` or `--raw`, a bare name
  fails `input/invalid-query`.

- Native API one-shot and incremental commands share their sentence builder;
  structured POST queries/projections reach both transports. Mutation and script
  requests reject unused query/projection flags, and PUT/POST reject a
  trailing row id instead of dropping it. Stream outcomes are read from
  `meta.operation.stream`; failed summaries retain cancellation warnings, and
  received terminal attributes survive a local stop (#400).

- **Native `api --stream` runs commands instead of always appending `/listen`
  (#399).** POST ping/monitor/print commands forward their attributes and emit
  replies incrementally; terminal attributes are retained. (#402, above,
  then made GET-menu streams literal.) Natural completion is `completed`; RouterOS/transport
  failures produce one `ok:false` summary and a nonzero exit, even after rows.
  **Breaking stream contract:** structured error envelopes now appear on stdout;
  failed summary counts/reason live in metadata, with no `data` key. Raw errors
  retain stderr behavior. Fatal sessions close locally even if the peer does not.

- **A menu the device does not have is no longer reported as a syntax error
  (#361).** RouterOS's `:parse` answers `/zerotier/print` on a router without
  the package with `syntax error (line 1 column 10)`, and `/zerotier print`
  with `bad command name zerotier`. Both point at the segment it could not
  resolve. centrs now locates that segment and looks the path up in its path
  catalog (every RouterOS 7.10–7.25 build, all extra packages):
  `validation/package-missing` when MikroTik publishes the menu behind a
  package (`error.context.packages`, with `/system/package/print` as the fix),
  `validation/menu-unavailable` when the gate is hardware, build or version
  (`/interface/w60g` needs `60ghz`; `error.context.gates`), and
  `validation/unknown-path` when no published build has it. The path can end
  in a command (`/system/license/output` is `nochr`), and the summary says so.
  A real syntax fault, and any rejection centrs cannot locate exactly (a
  menu-scope block, a menu named on an earlier line, a segment written twice),
  stays `validation/syntax`. Applies to every
  transport, since all of them classify the same `:parse` return. **Breaking
  for code that branches on `validation/syntax`** for these rejections: match
  `validation/package-missing`, `validation/menu-unavailable` and
  `validation/unknown-path` as well.
- **Every command now renders errors the same way, and keeps the router's own
  words (#362).** `execute`, `retrieve`, `api`, `transfer`, `settings`, the
  fan-outs and five others each had their own text renderer; most dropped the
  `Details:` link and RouterOS's position, and the device's own verdict was
  shown only with `--verbose`. All of them now use `formatCentrsErrorText`,
  which prints, in order: `[code] summary`, `At:` (RouterOS's line/column, or
  the offline gate's byte span with the bytes it covers), `Device said:`
  (RouterOS's message, one line, omitted when the summary already quotes it),
  `Fix:` and `Details:`. A test pins all fourteen renderers to the same text.
  `api --stream --format text` prints the same fields on one line, joined by
  ` — ` (`formatCentrsErrorLine`).
  Two remediation messages stopped claiming a cause they can't know: a device-stage
  `:parse` rejection no longer says "fix the quotes" (an absent menu or missing
  package is rejected in the same words; #361 separates them) and points to
  `centrs explain`, and the `routeros/api-trap` catch-all no longer says the
  command is likely invalid. The `:parse` preflight wrapper in `execute` also
  stopped dropping RouterOS's message from `context.detail`. `--json` output is
  unchanged apart from those remediation strings and the restored
  `context.detail`.

### Maintenance

- Refresh vulnerable dependencies within existing ranges and use Bun's
  Dependabot ecosystem for `bun.lock` (#390). Preserve the dependency group
  and the `has-flag` major-version ignore. Remaining dependency advisories
  and updater verification are tracked in #390.
- Pre-release dependency alignment (#390): runtime ranges now floor at the
  tested versions (`@modelcontextprotocol/sdk ^1.32.1`, `zod ^4.6.7`),
  `smol-toml` is overridden past its advisories, and `@types/bun` is pinned
  exactly to the 1.3.14 runtime (re-pin tracked in #438). The two residual
  advisories (`braces`, `katex`) are dev-tool-only and do not ship in the
  package.

## 0.1.7 — 2026-09-27

### Added

- **`centrs devices init` creates an empty CDB, `git init`-style (#376).**
  Bootstrapping a device book previously meant conjuring the file some other
  way. `centrs devices init [--cdb-file PATH]` (or `CENTRS_CDB_FILE`, or the
  default path) creates the parent directories and an exclusive `0600` file.
  **It never clobbers**, so a bootstrap script may run it unconditionally: an
  existing readable CDB succeeds with a `cdb/file-exists` warning and nothing
  is written. An existing file that fails to load (`cdb/parse-failed`,
  `cdb/password-required`) reports that error and is left untouched, and a
  location that cannot be written fails with the new `cdb/create-failed`. CLI
  and library (`initCdb`) only; not exposed on the MCP devices tool.

- **`devices list` reports the lookup keys it matches on (#378).** Rows now
  carry `identity` / `mac` / `ip` when the comment sets them, with
  `comment-kv` provenance in `sources`, and the text table gains an `IDENTITY`
  column. `comment` itself stays `show`-only.

### Fixed

- **Write-shaped commands now require confirmation, on every transport
  (#365, #366).** Write authorization was entangled with script-vs-structured
  transport selection, so several shapes reached a device without passing the
  `--yes` gate: selectors, positional ids, non-CRUD verbs, root mutators,
  indirect execution and relative menu writes. Authorization is now decided
  independently of how the command is carried. Read spellings are unaffected —
  the verb is the first known verb among the path's last segment and the bare
  words following the path token, so `/system identity print` and
  `:put [/system identity get name]` stay reads, while a statement with no
  recognizable verb still fails closed. Caller-addressed API `/execute` script
  strings additionally run offline analysis, then live `:parse`, then execute;
  structured API requests remain on `/console/inspect`. This advances the
  synchronous half of #154 without closing it — caller-controlled `file=`,
  `as-string` and async job-id semantics remain open there.

- **RouterOS rejections returned inside a successful transport envelope are no
  longer read as success.** `/execute` can answer 200 while the device's own
  text says it refused. Those are now classified as runtime failures, with the
  passed validation-stage history preserved so the envelope still shows what
  each stage concluded.

- **Device-stage validation missed RouterOS's bare `missing …` diagnostics
  (#375).** `classifyParseResult` matched `syntax error`, `bad command name`
  and `expected …` from `:put [:parse …]`, but not `missing closing brace` or
  `missing value for where` — so the device stage reported those rejections as
  a pass and the command ran. `/ip/address/find where=` passes offline, which
  made the device classifier its only gate. Replaying every bare diagnostic in
  the pinned corpus across 7.20.8 → 7.25beta3 finds exactly seven heads, and
  the two `missing …` forms were the only misses; both are now recognized, with
  the device's own position in `error.context.detail`. Echoed script text is
  still not a verdict.

- **A stream's `/cancel` acknowledgement is now bounded (#385).** `api
  --stream` stopped by `--duration` or Ctrl-C sent `/cancel` and then waited
  with no bound, so a connected router that never answered held the CLI open
  forever — `backend.close()` in the outer `finally` was unreachable while that
  wait was pending. The wait is now bounded by the request `--timeout`, the
  same bound as every other reply wait; past it the listen ends locally and the
  session closes. The summary keeps its real `stopReason` and adds a
  `transport/cancel-unacknowledged` **warning**, so the outcome never claims an
  acknowledgement that did not arrive. A cooperating router is unchanged.

- **`retrieve --attributes` rejected real singleton properties (#377).**
  `isKnownSingletonPath` knew only `/system/resource` and `/system/identity`,
  so every other singleton (`/tool/romon`, `/system/routerboard`, `/ip/dns`, …)
  was inspected as a list menu. `print,proplist` comes back empty on a
  singleton, so validation fell back to `print`'s own flags (`as-value`,
  `file`, `interval`, …) and offered those as the attribute list. The singleton
  bit now comes from the device: a singleton's `get` takes only `value-name`,
  while a list menu's `get` also takes `number`. The hardcoded pair survives
  only as the `--validate=false` fallback, which skips inspect. Costs one extra
  `request=child` for a menu that has `get`.

- **Completion candidates mixed help text and syntax rows into property names
  (#380).** `extractCompletionNames` read `completion`/`name`/`value`/`text`
  from every row, so the help string ("DNS cache size in kB") and the
  `show: "false"` syntax rows (`[`, `(`, `$`, `"`, `*`, `<value>`) were offered
  as attributes — which is why `--attributes '$'` passed validation. Rows carry
  only `completion`/`offset`/`preference`/`show`/`style`/`text`/`type` on every
  build recorded 7.9.2 → 7.25beta3, so `name`/`value` never matched anything.
  On CHR 7.23.7, `show: "true"` is exactly the property set. The exported
  `InspectCompletionItem` drops the never-present `name`/`value` and adds
  `show`/`style`/`offset`/`preference`.

- **An unparseable `<router>` crashed instead of reporting (#381).**
  `parseHostCandidate` passed the target straight to `new URL` — the only
  `new URL` on user input in `src/` — so with the default CDB, `quickchr:NAME`,
  `a b` or `bad:host:name` failed every command with a `TypeError: Invalid URL`
  surfaced as `internal/unhandled`. It now raises `input/invalid-target` and
  names the valid target forms; a `quickchr:NAME` guess is told to use
  `--quickchr NAME`. With an explicit CDB the same input already stopped at a
  classified `cdb/not-found-target`, so that path is unchanged.

### Changed

- **The pinned restraml inspect trees advance to the live channel builds.** The
  pins named "current stable" and "next beta" while pointing a patch behind
  both: stable 7.24.2 → 7.24.4 and development 7.25beta3 → 7.25beta5. History
  anchors 7.10.2 and 7.16 are untouched and both current versions stay
  architecture-paired. The refresh is structurally a no-op — the inspect union
  holds at 617 menus and the catalog at 1,120 paths, with no path added or
  removed and no kind change. What moved is current-only publication: the CLI
  Reference grew 1,053 → 1,055 pages (1,060 → 1,062 entries) and now documents
  `/interface/ethernet/pon` and `/ip/ssh/known-hosts`, so both move `inspect` →
  `both` (961 `both`, 65 `inspect`, 94 `published`). Zero
  navigation-vs-command contradictions, unchanged.

## 0.1.6 — 2026-09-15

### Changed

- **Release channels now use standard npm pre-release versions, not the even/odd
  minor rule.** `0.1.x` counted as "pre-release" only by an internal convention
  npm could not see, so every cut since 0.1.0 published to `next` and `latest`
  was left pointing at 0.1.0 — a plain `npm install @tikoci/centrs` handed you a
  June build while six releases sat on `next`. The dist-tag is now selected by
  the SemVer pre-release identifier: a `-`-suffixed version (`0.1.7-next.0`)
  publishes to `next` and never moves `latest`; a plain version (`0.1.6`)
  publishes to `latest` and carries `next` forward with it, so `@next` cannot
  resolve older than `@latest` between cuts. This release is the first plain
  version under the new rule, so `latest` and `next` both land on 0.1.6 — which
  is also the fix for the stale `latest`. The pre-1.0 caveats are unchanged:
  this is still an early preview, and `docs/MATRIX.md` remains the source of
  truth for what works.

- **Validation now runs offline first, then on the device.** centrs had two
  validators that did not know about each other: the device preflight
  (`:put [:parse …]` + `/console/inspect request=child`) that `execute` / `api` /
  `validate` share, and offline `explain`, which was byte-accurate and
  corpus-gated but took no part in validation at all. `execute` (all four
  transports) and `api`'s `/execute` script mode now run the analyzer as
  **stage 1**, before any connection: a syntax fault comes back with the
  offending byte span in `error.context.span` and the protocol adapter is never
  dialed, where `:put [` previously cost a full round trip to be told no. The
  `api /execute` carve-out is the larger change — that surface ran **no**
  preflight at all, so its script went to the device ungated.
  `meta.validation.stages[]` reports what each stage concluded and names a
  skipped stage's reason, so a reader can tell "the device accepted it" from
  "the device was never asked". Stage 1 is necessary and never sufficient: it
  has no per-menu schema, so it cannot see an unknown attribute, and the device
  stage is unchanged. An offline `warn` is an abstention and passes through;
  only a `fail` rejects. `--validate=false` disables both stages — one flag, one
  meaning (#354, and the ordering agreed on #236).

### Fixed

- **`'` is not a RouterOS token, and offline analysis now says so (#355).** `'`
  is not a string delimiter and not a legal bare byte — only `"` opens a string.
  `:parse` rejects `name=don't`, `name=don't'`, `name='abc'` and `:put 'abc'`
  byte-identically on CHR 7.21.5, 7.23.5, 7.24.2 and 7.25beta3, and offline
  `explain` passed all four with ZERO diagnostics, dropping the byte into
  `unclassified`. It now raises `explain/canonicalizer/invalid-apostrophe` on
  the apostrophe's own byte — which is the device's own reported column in every
  case — while an apostrophe inside a `"`-string or a comment stays legal. Rows
  2-4 above carry BALANCED apostrophes and are rejected anyway, so this is a
  lexical rule and not a quote-balance one. Being a false ACCEPT, it was
  invisible to the corpus false-reject join, which scores one direction only.
  Over the pinned corpus the rule fires on 40 scripts and every one is
  device-rejected: the false-reject count is unchanged at 1 and the caught count
  goes 62 → 93. Symbol resolution stops at the apostrophe too, the way it
  already stopped at a malformed escape, so `:put 'abc'; :put $after` no longer
  publishes an occurrence for `$after` — that returns 306 bytes to
  `unclassified` and is the only census movement; value, operator and
  bracket-equals are unchanged.
- **The quote-count preflight that modelled `'` as a delimiter is gone.**
  `execute` carried a private `hasUnbalancedQuotes` check, moved into the
  offline gate by #354 and kept there only because it was the one thing catching
  the apostrophe case. It had no comment awareness, so an English contraction in
  a `#` comment opened a quote it never closed — over the pinned corpus it
  false-rejected **51** of the 617 scripts CHR 7.24.2 accepts, a figure the
  published measurement never saw because that measurement ran `explainCommand`
  rather than the whole gate. Removing it costs 21 catches, all on scripts the
  device rejects anyway and where the device stage still applies, and takes the
  gate's false rejects from 52 to 1.

- **CI: the three console reads that RouterOS 7.23.6/7.24.3/7.25beta4 broke.**
  Those builds print a settings menu that has exactly one property — of the
  menus centrs reads, only `/system/identity` — one character per line, so
  `name: CHR` comes back with `C`, `H` and `R` on three lines under the label.
  It is neither a terminal-width effect nor transport-specific: REST `POST /rest/execute` wraps identically to the
  ssh and mac-telnet consoles, and every multi-property `print` is unaffected
  (measured on stock CHR 7.24.2 vs 7.24.3). `execute --via ssh`,
  `execute --via mac-telnet`, and `terminal --via ssh` now assert the identity
  they read with `print` column wrapping collapsed on both sides, so the
  examples are evidence about the console round-trip rather than about a
  device layout MikroTik is free to change (#352).
- **CI: the CHR image cache now rotates with the RouterOS point release.**
  `actions/cache` only writes on an exact-key miss, so the old static key froze
  the first image it ever saw: every stable bump was re-downloaded from
  download.mikrotik.com on *every* job and never saved. A 186s cold download
  duly timed out the 300s `chr-smoke` test on the 7.24.2 → 7.24.3 bump. The key
  now carries the version the job will boot (`scripts/chr-cache-key.ts`), the
  smoke test gets the headroom a cold download needs, and the QA leg's own
  timeout absorbs one — a cold download had also been cancelling a whole
  channel leg mid-suite with every assertion green (#352).

## 0.1.5 — 2026-09-15

*Tagged but never published: the release-tier CHR sweep failed on the
7.23.6/7.24.3 console-wrap and image-cache defects that #352 then fixed, so npm
has no 0.1.5. Everything below shipped in 0.1.6.*

### Added

- **Offline `explain`'s token partition is now scored against the device.**
  `bun run explain:highlight-agreement` projects each centrs token class onto
  the RouterOS `/console/inspect request=highlight` class it predicts and
  reports where the two agree, over the committed capture slice — no router, no
  corpus, no network. The report separates what it can score from what it
  cannot: each side's abstentions, and the tail after the device's own one-byte
  `error` — half the slice's bytes, where 7.23.2 falls silent for the rest of
  the script and 7.24rc2 mostly does. A second axis says why an answer was out of reach — offline-decidable,
  schema-dependent, state-dependent or version-dependent — assigned per byte
  from context rather than by class name, since one highlight class carries more
  than one category. Representative source fragments ship with the counts.
  Figures are a trend line over a known-biased corpus, never a pass threshold
  (#264 B4, #263).

### Fixed

- **Offline `explain` no longer rejects two RouterOS spellings every tested
  build accepts.** Measured, not guessed: running the analyzer over all 948
  corpus scripts and comparing to each build's own `:parse` verdict found four
  device-accepted scripts that offline analysis hard-failed, identical on
  7.23.5, 7.24.2 and 7.25beta3. They were two language gaps, and both are now
  fixed — the count is 1, and the one that remains is the device tolerating a
  genuinely extra `}`, where explain is arguably the stricter of the two.
  - A scope slot may drop the `=` before its brace: `:if (…) do={…} else {…}`
    and `do {…}` are the same construct as the documented `else={…}` form.
    `:parse` lowers all of the spellings to byte-identical IL on CHR 7.21.5,
    7.23.5, 7.24.2 and 7.25beta3, with `elsy {` rejected on all four as the
    control. Only the four `SCOPE_ARG_NAMES` members may drop it, so
    `:local z {1;2}` still reads its brace as an array literal, and a colon
    disqualifies the word — the device parses `do {…}` but refuses `:do {…}` in
    an argument slot, since a colon makes it a directive (#347).
  - A relative menu-scope block composes the path: `/ip { address { print } }`
    is `(evl (evl (evl /ip/address/print)))` on the device, and a block body may
    open with a submenu, one of the thirteen frozen CRUD verbs, a scripting
    directive, or an absolute command. The absolute spelling already worked; the
    nested relative one hard-failed. An unknown menu still does not become a
    pass — the catalog's "a miss says nothing" contract means it abstains rather
    than being claimed either way (#348).

  As a side effect the offline token partition agrees with the device on 8 more
  bytes of the committed slice, all of them moving out of *offline-silent* into
  *agree*, with no new disagreements.

- **`centrs api --raw` no longer silently discards an explicit `--validate`.**
  `--raw` short-circuited the whole settings ladder, so `--raw --validate=true`
  ran no preflight at all — and `CENTRS_VALIDATE`, the CDB comment-kv override
  and config lost to it just as quietly. It is now a precedence layer: the
  explicit `--validate` flag wins, then `--raw`, then the ambient sources, then
  the `true` default. `--raw` alone is unchanged and still behaves identically
  on every machine whatever the environment holds, while `--raw --validate=true`
  runs the gate and reports a rejection in the `--raw` error shape
  (`{code,message}` on stderr, nonzero exit, no `data` key) — the intended way
  to debug `api` when centrs itself is the suspect (#154).

- **`execute`/`api` validation no longer probes command-level
  `request=completion`.** On RouterOS 7.12.2 that request shape never answers:
  REST hangs past the client timeout (then surfaces the router's own session
  close mislabeled as `validation/syntax`) and the native API closes the
  connection outright, so every validated call — plain reads included — failed
  on that build while `--no-validate` succeeded instantly. The attribute set
  those two commands check against now comes from command-level
  `request=child` alone, through the shared `inspectArgumentNames` helper;
  `child` returns the complete argument list in single-digit milliseconds on
  the same 7.12.2 controls, so nothing is lost by dropping the union.
  `meta.validation.source` reads `/console/inspect request=child`.
  `retrieve` is unchanged — its argument-level completion probe
  (`print,proplist` / `get,value-name`) is a different request shape and
  answers normally on 7.12.2 (#343).
- **The reported package version is the real one.** The library's
  `centrsVersion` and the MCP `initialize` handshake both announced a
  hard-coded `0.1.0` regardless of what was published, so a bug report from an
  MCP client named the wrong build. Both now derive from `package.json`
  through `src/core/version.ts`, and a unit test holds them to it (#343).
- **Offline `explain` no longer invents a verb for a menu path with
  arguments.** `/ip/firewall/address-list name=ytkids timeout=1h` reported
  `resolved`, path `/ip/firewall`, verb `address-list` — and the spaced
  spelling `/ip firewall address-list name=x` promoted `firewall`, one level
  higher still. Both premises were already offline facts and both said no: the
  whole run is a known menu, and the promoted segment is not a console verb.
  The reading is now an `ambiguous` abstention with a located diagnostic saying
  which menu and which segment. Priced on the frozen dev/holdout partition, 10
  of 17,212 statements flip, every one of them a fabrication withdrawn — three
  real RouterOS statements missing their verb and seven lines of pasted
  non-RouterOS prose. Presence in the shipped structure tables still narrows a
  reading and absence still decides nothing, so an unlisted menu is read
  exactly as before (#324).
- **Offline `explain`'s token partition reaches inside a command
  substitution.** `:put "$[/ip address print as-value]"` came back as one
  opaque `string` run over a command `data.structure.subcommands` already
  reported as resolved, so an editor rendering `data.tokens[]` painted an
  interpolated string flat. The path fill was being handed a span computed as
  "one byte inside the brackets", which is wrong for `$[…]` (the sigil is part
  of the span) and for `[ … ]` (the inner text is trimmed); both spellings now
  carry a published `innerSpan` instead. Byte coverage does not move — what
  moves is which fill owns those bytes (#325).

### Changed

- **Every live fixture is re-swept onto the current release channels.** The
  operator sweep was pinned to 7.23.3 stable / 7.24rc4 testing / 7.21.5
  long-term and the highlight slice to 7.23.2 / 7.24rc2 — none of them a
  current channel, and none a build the corpus covers with both oracles, so the
  operator axis and the token partition were never scored on the same firmware.
  Both now run on the three builds the corpus classes `complete`: stable
  **7.24.2**, long-term **7.23.5**, development **7.25beta3**. The slice bases
  on stable, where development serializes as `null` throughout and only the 33
  long-term splits cost bytes. The sweep keeps **7.21.5** as a fourth build,
  explicitly an age anchor rather than a channel claim — it is the only live
  evidence that the operator surface behaves the same on a pre-7.23 branch, and
  dropping it would have retired a fact rather than refreshed one (#342, #336).
- **The live sweep independently reproduces the corpus's channel split.**
  Highlight agreement is byte-identical between stable and development in every
  bucket and differs on long-term — the same shape the corpus IL showed at
  87/11 and 33/0. Two oracles, two capture paths, same conclusion.
- **Array comparison is not fixed on current long-term.** `:put ({2;1} >
  {1;2;3})` evaluates on 7.24.2 and 7.25beta3 and errors on 7.23.5 and 7.21.5.
  7.23.5 is *newer* than the 7.23.3 this was first measured on and still errors,
  so the change rode the 7.24 line and was never backported —
  `ARRAY_COMPARISON_NOTE` now says so. The device's post-`error` recovery flipped
  with the same realignment: `parser-recovered` is 0 on long-term and 96 bytes
  on both stable and development.

- **The bracket-`=` abstention figure is generated and gated instead of
  asserted.** `commands/explain/README.md` and `src/explain/operator-tokens.ts`
  both quoted a `224` / `1,259` / `1,035` split for the cost of leaving `=`
  inside `[ … ]` unclaimed. No script produced it, no `:check` gated it, and no
  universe reproduces it — it was written once in PR #292 and had been prose
  ever since, which is exactly the condition a corpus repin can silently
  invalidate. `bun run explain:bracket-equals` now derives it, with `--check`
  and `--readme --check` gates on the corpus → fixture → README chain like the
  other censuses, and the README block is generated. Measured: **1,079** `=`
  bytes inside `[ … ]` across 263 of 948 scripts, **1,067** left
  `unclassified` — **448** genuine `find`/`where` query comparisons against
  **619** plain `arg=value`. The `arg` fill rescues **none** of them, contrary
  to the obvious guess, because it offers only the `=` its own located argument
  token names. The query reading is the device's: on 7.24.2, 93 of the 109
  scripts that parsed carry at least as many `(= …)` IL nodes, and the
  shortfalls are scripts whose enclosing menu the capture build could not
  resolve (#341).

- **The operator census reads only version-comparable RouterOS builds.** The
  corpus is repinned to `lsp-routeros-ts` `7d62355` (schema v4), which carries
  three *complete* builds — long-term 7.23.5, stable 7.24.2 and development
  7.25beta3, each with both oracles over all 948 scripts — beside six partial
  captures covering 913. The census summed occurrences across every version it
  found, so the added build inflated every head count by ~20% while
  `distinctScripts`, the column carrying the argument, did not move at all. It
  now filters on the new `v_version_coverage.coverage_class = 'complete'` view,
  giving a rectangular universe of 2,841 parse-IL rows — 3 builds × the 947 of
  948 scripts that produce IL — and states its version set so a gate cannot
  compare two different universes. Presence *is* monotone in coverage, so
  the partial builds keep one job: a new `headFirstSeen` axis dates each head
  against every captured build — which is what still grounds the `any` operator
  at 7.20.8, a build the counting side no longer reads. `source_scripts` is
  byte-identical across the repin, so every text-derived report — the token and
  value censuses, `explain:arg-reach`, the browser-consumer proof — is
  unchanged by construction (#336, #342).
- **The three complete builds are recorded as disagreeing.** `:parse` IL differs
  on 87 of 948 scripts between long-term 7.23.5 and stable 7.24.2 but on only 11
  between stable and development 7.25beta3; `highlight` differs on 33 and 0. So
  an operator-axis or token-partition figure is a claim about a *channel*, not
  about RouterOS, and `commands/explain/README.md` now says so rather than
  collapsing the builds to one number.
- **A valid string escape is now its own token class in offline `explain`.**
  `ExplainTokenClass` gains `escaped`, the second and last split #264's rule
  admits: only INVALID escapes surfaced anywhere else, as `bad-string-escape`
  diagnostics, so a consumer holding `tokens[]` had no published surface to join
  against to find the valid ones — and the device names them. The escape grammar
  is not walked a second time to do it: `walkStringEscapes` now returns both
  halves of the one reading `bad-string-escape` already came from, so a token
  and a diagnostic cannot disagree about which bytes are an escape, and it stops
  claiming at the first invalid escape rather than guess past a malformed one.
  **Byte coverage does not move** — classified bytes are identical to the last
  decimal; `escaped`'s 19,960 corpus bytes come out of `string` (−17,672) and
  `value` (−2,288) exactly, and the token count rises only because a run
  carrying an escape becomes three. Against the committed device slice the class
  agrees on 418 of 418 bytes and the `unprojected` residue falls 1,051 → 633.
  Consumers reading `data.tokens[]` for `string` or `value` must now also read
  `escaped` to see bytes they used to get inside one run. A `\`-newline line
  continuation in **code** is deliberately not claimed — the device calls it
  `escaped` too, but its run swallows the next line's indentation, and what a
  continuation owns is #225's question (#264).

- **Offline `explain`'s token vocabulary is no longer provisional, and the
  argument `=` has its own class.** `ExplainTokenClass` gains `arg-sep`: an
  argument's name bytes stay `arg`, and the single `=` binding it to its value
  is now named separately. #264 B5 settled the whole vocabulary on a stated
  rule — a merged class is split only where a consumer needs the distinction
  AND cannot recover it by joining `tokens[]` to another published surface on
  byte offsets — so the per-spelling `operator`, per-shape `value`,
  scope-versus-array `brace` and string-delimiter merges stay merged, each with
  the surface that already carries the distinction named. The `=` was the one
  that failed the test: 30.8% of the `=` runs the fill paints (5,088 of 16,526
  on the pinned corpus) belong to a statement whose strict `arguments` reading
  refused, led by the `do=` of every `:if`/`:foreach`/`:while`, so there is no
  published `valueSpan` to derive the boundary from. **Byte coverage does not
  move** — classified bytes are identical to the last decimal; this is a retag,
  and the token count rises only because one run became two. Against the
  committed device slice, projection disagreements fall 360 → 2 as centrs stops
  calling a separator a name. Consumers reading `data.tokens[]` for `arg` must
  now also read `arg-sep` to see the bytes they used to get in one run
  (#264 B5, #316).

- **Offline `explain` answers statement-ownership from an index, not a scan.**
  The symbol/value surface asked "which statement owns this span" once per
  symbol, value and scope brace by scanning every statement split, so cost grew
  quadratically with symbol-dense input: 253 KiB of declarations took 4.3 s and
  was still steepening. Output is unchanged — all 1,896 `explainCommand` hashes
  over the pinned corpus match byte for byte under both facet settings — and the
  growth-ratio guard now covers a symbol-dense input shape alongside the
  separator-free one (#317).

## 0.1.4 — 2026-08-31

Preview release. `@tikoci/centrs@0.1.4` on npm's `next` tag.

### Added

- **Offline `explain` is now a real CLI and library surface.** It analyzes
  RouterOS commands and scripts without a router, CDB, or network connection,
  returning canonical structure, diagnostics, write-shape and transport
  classification, optional `curl` rendering, symbols, value-shape hints, and a
  gapless token partition. Try it with
  `bunx @tikoci/centrs@next explain '/ip/address print' --json`.
- **Generated RouterOS structure evidence.** Pinned inspect trees and
  MikroTik's published CLI Reference now help distinguish known menus from
  commands while preserving the fail-closed rule: missing catalog entries never
  become rejections, schema claims, or runtime-acceptance claims.
- **Named quickchr targets.** Router-facing commands can resolve an ephemeral
  quickchr instance with `--quickchr <name>` through the shared target-provider
  path.

### Changed

- **Offline analysis is substantially more precise and robust.** Grounded
  handling now covers RouterOS comments, escapes, operators, arrays, value
  shapes, path context, and flow-sensitive symbol-to-value references; bounded
  traversal and shared statement indexes keep large inputs near-linear.
- **Release and QA coverage is broader.** Recency-aware RouterOS channel
  selection, long-term-version expectations, generated-artifact drift checks,
  corpus gates, and faster local Git gates make the published preview easier to
  reproduce and audit.

### Fixed

- **Validation now reads RouterOS `:parse` results instead of accepting the
  transport round-trip alone**, and retrieve errors retain the rejected
  parameter. Parser, catalog, cross-platform QA, and MAC-Telnet edge cases were
  also hardened.
- **The npm package now carries the MIT license text.**

## 0.1.3 — 2026-07-06

Patch release. `@tikoci/centrs@0.1.3`.

### Added

- **`api` command over rest-api + native-api is `CHR-passed`.** `centrs api`
  brings a `gh api`-style structured passthrough to both transports, and folds
  the old standalone `stream` command into `api --stream` (native-api only,
  `--listen` alias): a `NativeApiSession.listen()` reader with `/cancel`
  support emits NDJSON frames plus a run summary. Grounded against real CHR
  7.23.1.
- **Multi-target fan-out is uniform across `api`, `retrieve`, `execute`, and
  `transfer`.** A shared `expandCdbSelection` + `runFanout` + `fanoutExitCode`
  core (extracted once, consumed by all four commands) lets any command take a
  CDB selector and run over every matching device. The positional boundary
  that ends the selector differs per command (final positional for
  `api`/`retrieve`, `--` for `execute`, the verb keyword for `transfer`);
  `terminal` and `api --stream` explicitly reject `N > 1` selections since
  neither has a sane multi-target framing.
- **`settings` command (`print` / `get` / `set` / `reset`).** A managed-key
  registry for the real `CENTRS_*` environment keys backs an atomic
  `centrs.env` writer: `set` validates per key, canonicalizes booleans to
  `1`/`0` on disk, warns (never blocks) on consequential values
  (`insecure=true`, `transfer-via=ftp`), and never partially writes on a
  validation failure; `reset` deletes the managed line rather than blanking it
  (a blank value would itself mean "set to empty" for a bash-sourced file) and
  leaves foreign lines/comments untouched. Bare `centrs settings` behaves like
  `print` regardless of TTY. Four new error/warning codes
  (`settings/reserved-key`, `settings/unknown-key`,
  `settings/consequential-value`, `settings/skip-env-file-active`) plus
  `internal/settings-failed`, all cataloged. `CHR-passed` via 32
  fixture-backed integration examples.
- **Device GPS: lat/lon/altitude storage + `--near` / `--bbox` geo
  predicates.** `centrs devices` now stores GPS coordinates per device
  (lat-first ordering, chosen so agents guess the field order correctly) and
  supports proximity
  (`--near`) and bounding-box (`--bbox`) selection predicates. `CHR-passed`
  via fixture-backed integration coverage.
- **Registry⇄MATRIX drift guard + "did you mean?" flag errors.** A CI-checked
  guard keeps the command/protocol registry and `docs/MATRIX.md` from
  silently drifting apart; unrecognized CLI flags now suggest the closest
  known flag instead of a bare rejection.
- **GitHub Pages: published API reference + error catalog.** `typedoc` output
  and the generated error-code catalog now publish to GitHub Pages on push.

### Fixed

- **Windows unit-test portability for `settings` and MNDP.** Path-separator
  and related platform assumptions in the `settings` and MNDP unit suites are
  now Windows-safe (#170).
- **A real CodeQL-caught ReDoS in the device GPS geo-predicate parser**, fixed
  rather than suppressed.

### Changed

- **CodeQL house-rules pack promoted to the default run**, alongside CodeRabbit
  review-tone tuning and a reduced GitHub-checks timeout (15 → 7 minutes).

## 0.1.2 — 2026-06-26

Patch release. `@tikoci/centrs@0.1.2`.

### Added

- **`btest` TCP multi-connection fan-out is `CHR-passed`.** `centrs btest
  --connection-count N` now realizes the full fan-out: the client reads the
  session token from the primary's OK handshake and opens `N-1` additional TCP
  data connections, each sending the grounded secondary-join
  (`[token:u16 BE][0x02][0…]`). All connections drive into one shared
  `BandwidthCounters` so throughput aggregates. Wire format confirmed
  byte-for-byte against RouterOS 7.23.1 (the server sends a 4-byte HELLO per
  connection then waits for all to join before streaming — sequential opens must
  not block on a reply, or the first secondary deadlocks the server). Unauthenticated
  TCP fan-out works end-to-end; authenticated (EC-SRP5) sessions stay single-stream
  and warn when the realized `activeConnections` falls short of the requested count.
  `BtestRunSummary` / `BtestClientData` gain an `activeConnections` field.
  Grounded via unit tests (secondary-join byte format, loopback fan-out) and
  integration example 11 on real CHR (4 connections open, data flows on each).

### Fixed

- **`btest` UDP client receive reported 0 bps.** The UDP socket was bound with
  `connect()` (filtering by remote address/port), which dropped the
  bandwidth-server's probe packets because they arrive from the server's data
  port, not the control port. The socket is now unconnected; `--remote-udp-tx-size`
  emits a warning when unset (needed by the server-push direction only).
  UDP `receive` and `both` cycles are now CHR-gated on real RouterOS (rx ≈ 474 KB
  in CI).
- **`btest --connection-count` was silently ignored.** The count was validated and
  accepted but never encoded into command byte 3 of the client hello, so RouterOS
  always saw `count=0` and opened a single stream. The value is now threaded through
  `BtestClientSessionOptions` → `clientHandshake`. A
  `routeros/btest-connection-count-single-stream` warning fires for
  `connection-count > 1` sessions that fall back to one stream (e.g. EC-SRP5 auth).
- **`btest direction=both` TX was unbounded, starving RX.** In TCP `both` the client
  ran no status reader, so TX had no feedback, saturated the link, and collapsed
  server→client RX. The `tcpRxLoop` now demuxes embedded 12-byte status frames
  in-place by their structural marker (`0x07 ?? 00 00`) and passes them through the
  shared `applyStatusFeedback` / `adaptTxFromStatus` gate used by
  `tcpStatusReaderLoop`. A per-frame plausibility guard (CPU byte ≤ 100; sane
  sequence ceiling) filters false matches from `--random-data` bulk streams.
  Grounded: a CHR `both` run fires 5 feedback events (server bytesReceived
  78840 → 643860) and paces TX; RX is sustained instead of collapsing.

## 0.1.1 — 2026-06-22

Patch release. `@tikoci/centrs@0.1.1`.

### Changed

- **CI is now faster on PRs.** Cross-platform unit tests (macOS + Windows) moved
  from `ci.yaml` to `qa.yaml`, where they run in parallel with the CHR matrix on
  every push to `main`. PRs no longer wait for macOS/Windows runners; escapes are
  caught on the merge-to-main QA run instead.

### Fixed

- **CLI: registry-aware `missing-router` tips.** All router-taking commands now
  emit a CDB-aware tip when no `<router>` argument is supplied — listing saved
  handles from the CDB (`tip/select-target`) or pointing to `centrs discover
  --save` when the registry is empty (`tip/no-devices`).
- **`discover --save` lookup keys and progress.** The saved device record now
  includes `identity=` and `mac=` keys so downstream commands can resolve the
  entry; MAC addresses are de-duplicated. TTY progress is shown during a scan and
  a `--save` tip is printed at the end of a bare discover run.
- **CodeQL / security hardening (PR #80 review).** Addressed reviewer findings:
  clear-text credential log suppressed; progress output switched to stderr/JSON-safe
  path; `retrieve` resource leak closed; doc corrections.

## 0.1.0 — 2026-06-22

First published pre-release (odd minor → npm `next`). `@tikoci/centrs@0.1.0`.

### Added

- **`btest / client` is now `CHR-passed`.** A direct centrs-client → CHR
  `/tool/bandwidth-server` gated test (`test/integration/btest-client.test.ts`)
  boots a CHR with a host→guest `tcp:2000` forward and runs the centrs client
  against real RouterOS: unauthenticated TCP receive, an **EC-SRP5 client proof
  verified by RouterOS's own server verifier**, and a wrong-password reject (CHR
  7.23.1). This closes the last open product-grid cell — the client cell was
  previously grounded only transitively (loopback + the server test). The
  integration harness (`test/integration/chr.ts`) gains an `extraPorts` option for
  arbitrary host→guest forwards. UDP client→server and TCP `connection-count > 1`
  fan-out remain loopback/transitive (README, Open questions).
- **CI/release rework — staged gate, definitive QA matrix, NPM publish, extended
  sweep.** The CI surface is reconciled with the tier/versioning doctrine
  (quickchr's `ci`/`publish`/`verify-extended` scheme as the reference).
  `ci.yaml` is a staged push/PR gate (lint ‖ unit+coverage → **stable CHR smoke**
  → cross-platform unit) with coverage + failing tests surfaced to job summaries
  and artifacts. `qa.yaml` is the definitive RouterOS channel matrix (push +
  weekly + dispatch + `workflow_call`) with **event-aware concurrency** (a new
  main push cancels the old run; dispatches never cancel one another — including
  an `all`-channels dispatch in a single run) and a `bun:sqlite` results store.
  `codeql.yaml` carries security/quality scanning on its own cadence.
  `release.yaml` publishes to npm on a `v*` tag (even/odd minor → `next`/`latest`,
  `--provenance`, dry-run) — **requires the `NPM_TOKEN` repo secret**.
  `verify-extended.yaml` adds a dispatch-only macOS-x86 / Windows-x86 sweep. New
  `chr-smoke` integration test + `test:integration:smoke` script; `.coderabbit.yaml`
  stages bot review to conserve credits.
- **QA recency-aware channel matrix + cross-run history + must-pass gate.**
  `qa.yaml`'s channel axis is now resolved per run by a `resolve-matrix` pre-flight
  job (`scripts/qa-active-channels.ts`) instead of a hard-coded list: it asks
  quickchr 0.4.2's public version/channel API (`resolveAllVersions` /
  `selectActiveChannels`, with the suffix-aware `compareRouterOsVersion` that
  finally orders `7.24beta2 < 7.24rc1 < 7.24`) for the channels *worth booting* —
  the released channels (stable, long-term) always, plus any pre-release (testing,
  development) at or ahead of stable. This closes the `testing` blind spot and
  auto-adapts as MikroTik promotes builds, because the four channels are not
  monotonically ordered (a stale `testing` rc is skipped; it is picked up
  automatically once it leapfrogs stable). A new `accumulate-and-gate` job appends
  each CHR run to a durable append-log on the `qa-history` branch (per-run
  artifacts have finite retention, and the channel→version drift over time is
  what a long history captures) and fails the run **only when a released
  channel (stable, long-term) regresses** — pre-release legs are best-effort, so a
  beta btest/EC-SRP5 flake (JG-31) is recorded but never reds main. Boundary:
  quickchr owns recency ("what's worth booting"); centrs owns the gate ("what must
  pass") — the must-pass policy lives once in `scripts/qa-results-db.ts`
  (`channelPolicy` / `evaluateMustPassGate`, mirrored by the matrix
  `continue-on-error`), with the cross-run accumulator in `scripts/qa-history.ts`.
- **`transfer / ssh` (sftp) — SSH lands transfer-first.** SSH joins centrs as a
  self-contained **SFTP transfer client** (`src/protocols/sftp.ts`) over the host
  OpenSSH `sftp` subsystem — the only reliable SSH file path, since RouterOS's SSH
  server has no exec channel / no pseudo-tty (so `execute`/`terminal` over SSH,
  which need an interactive-shell reader, are a deliberate later pass). This
  re-scopes the earlier "SSH lands as one unit" plan. `transfer` now routes
  `--via sftp` (and auto-selects it for >60 KB uploads, the gap the REST `/file`
  60 KB write cap leaves) through a new backend-agnostic `FileBackend` seam
  (`AdapterFileBackend` for rest/native, `SftpFileBackend` for sftp). The
  `ssh-key` (`--ssh-key` / `CENTRS_SSH_KEY` / CDB `ssh-key=`) and `insecure`
  settings land with the transport. **Green against real CHR 7.23.1** (98
  assertions, `test/integration/transfer.test.ts`): a key-auth sftp round-trip,
  the >60 KB upload, list/mkdir/remove, and example 17 (chunked REST read of an
  sftp-seeded file — the old fetch hack is gone). **CHR finding:** RouterOS's sftp
  `ls -l` does not report a reliable byte size, so the sftp `--verify size` trusts
  the SFTP transfer guarantee rather than re-reading a size. New error codes:
  `transport/host-key-mismatch`, `transport/insecure-trust`,
  `transport/auto-method`, `input/invalid-path`. On-device `copy` has no SFTP
  primitive and stays on rest/native.
- **Unified TLS / SSH host-key trust across every transport.** One opt-out —
  `--insecure` (`CENTRS_INSECURE`, CDB `insecure=`) — with verify-by-default and a
  `transport/insecure-trust` warning when it is set. REST (`fetch`) and native-api
  (`api-ssl`) now both **verify** TLS by default (native-api previously accepted
  any cert silently); a self-signed cert fails with `transport/tls-certificate`
  whose remediation names `--insecure`. SSH host keys default to
  `accept-new` trust-on-first-use; a changed key fails with
  `transport/host-key-mismatch`. See `docs/CONSTITUTION.md`, Transport trust.

- **`transfer` is `coded` for `rest-api` / `native-api`.** `src/transfer.ts` +
  `src/cli/transfer.ts` implement the file verb — `upload`/`download`/`list`/
  `remove`/`mkdir`/`copy` (plus top-level `upload`/`download` aliases) — over the
  RouterOS `/file` menu, driven through the shared `ProtocolAdapter`
  `execute`/`list` seam so REST and native share one path. Size/direction-aware
  method selection encodes the asymmetric `/file` plumbing (writes capped at
  60 KB via `/file/set contents`; reads scale via chunked `/file/read`), a
  `print`-probe enforces validate-before-write (refuse-overwrite unless
  `--force`), a leading `/` in a remote path is normalized away, and
  `sftp`/`scp`/`fetch`/`ftp` report a defined not-implemented / gated error.
  Unit-green via mocked `fetch` (`test/unit/transfer.test.ts`).
  `test/integration/transfer.test.ts` is green against a real CHR 7.23.1 (98
  assertions, after the sftp commit below also seeds example 17) — confirming the
  `/file` `get`/`set`/`add`/`copy`/`remove` wire shapes over both REST and native
  — covering all examples except the three deferred for harness reasons (8–10
  stdin/stdout/default-local), so the cells stay `coded` shy of the strict
  every-example `CHR-passed` bar. New error codes: `usage/target-exists`,
  `transport/incomplete-transfer`, `transport/checksum-unavailable`,
  `input/local-file-not-found`, `settings/unsafe-protocol-blocked`.
- **`discover / mndp` is `CHR-passed`.** A real layer-2 integration test
  (`test/integration/discover.test.ts`) boots a CHR with a second
  `socket-connect` NIC and a host bridge (`test/integration/mndp-l2-bridge.ts`)
  that lifts each frame's UDP/5678 payload into centrs's unmodified `discover()`
  listener and injects MNDP refresh frames back over the link. It captures and
  decodes a genuine RouterOS MNDP announcement (CHR 7.23.1), cross-checks
  `identity`/`platform`/`board`/`version`/`mac` against REST, and `--save`s a
  `macTarget`/`group=discovered` record. The `socket-connect` approach was first
  proven against quickchr's own `examples/mndp/` guinea-pig run. The same bridge
  (frame-injection write-back) is the L2 harness mac-telnet will reuse.
- **Integration CHR can now boot a chosen arch + extra packages.**
  `startIntegrationChr` reads `CENTRS_CHR_ARCH` (`arm64`/`x86`) and
  `CENTRS_CHR_PACKAGES` (comma/space list) and threads them through quickchr
  0.4.2's `StartOptions`; `verify-extended.yaml` gains a `packages` input that
  installs them into the CHR (e.g. `container`) for a fuller-RouterOS sweep. The
  arm64 path is wired on the centrs side but no arm64 job is added yet: quickchr
  0.4.2 has an arm64 REST-POST bug (returns the prior GET's body) that breaks the
  execute path every integration test uses, so an arm64 job would be known-red
  until that upstream fix lands.

### Fixed

- **`package.json` declares its `repository` (and `homepage`/`bugs`).** Without it,
  `npm publish --provenance` failed validation (`E422`: empty `repository.url` vs
  the GitHub-Actions provenance source). The package now points at
  `github.com/tikoci/centrs`, matching the signed provenance.
- **Flaky must-pass CHR cells no longer red the release gate.** The first
  `v0.1.0` release sweep was blocked by transient long-term failures (native-api
  `ECONNREFUSED`, mac-telnet L2 prime-latency) — the same cells pass locally and
  the reds hop channels run-to-run, i.e. CI timing flake, not regressions. Two
  fixes: (1) the native-api integration test now `waitForBoot`s and retries the
  cold connect past the boot-readiness race (the api service can lag the REST
  endpoint), via a `withBootReadyRetry` harness helper that retries **only**
  transient connect errors — `auth-failed` still propagates, so assertions are
  unweakened; (2) the qa.yaml CHR sweep runs integration **per-file with one
  retry** — a real regression fails both attempts and still gates, but a single
  transient flake is absorbed, and per-file isolation avoids the resource
  contention that fast-fails a later file.
- **`windows-latest` unit tier is green.** It was perpetually red on two causes,
  now both addressed without losing coverage: (1) Windows has no `SO_REUSEPORT`,
  so the MNDP/btest UDP loopback binds (`reusePort: true`) threw `ENOTSUP` — a
  capability probe (`test/unit/udp-loopback.ts`) now skips just those UDP tests on
  such a runner (TCP + CHR integration keep the coverage), gating only on the
  known-unsupported bind codes so real regressions still surface; (2) the
  `ssh`/`sftp` argv tests asserted `/dev/null` where the src correctly emits `NUL`
  on Windows, and `transfer.basename()` split on `/` only so an omitted upload
  remote defaulted to the full `C:\…` path — it now splits on `\` too.

- **`btest` bidirectional TCP server tx is now accounted.** A `direction=both`
  TCP session reported `totalTxBytes=0` / `txAvgBps=0` on the server side even
  though it transmitted the client's receive half (hundreds of MB): the server's
  bulk-TX loop flushed only its rx into each interval, never its own tx. The
  server now records both halves, so a `both` session's `data.sessions[]` and the
  CSV/text renders carry a non-zero tx rate. Loopback-grounded
  (`test/unit/btest-{session,command}.test.ts`); UDP `both` and single-direction
  TCP were already correct.
- **`btest` totals now flush the final partial interval.** The per-interval
  accounting loops recorded totals on a tick cadence and exited without folding in
  bytes that arrived after the last tick (or before the first, on a slow host), so
  a short run under-reported the final fraction of a second of each direction.
  `driveSession` now folds the remaining counter bytes into the totals on stop,
  keeping `data.reports[]` lossless against them.
- **`discover` default listen window is now `15s`** (was `60s` in code).
  Lowering the window relied on the up-front refresh broadcast (sent immediately,
  then every 5s) so responders reply within a round-trip; the per-command docs
  already documented `15s`, but `DISCOVER_DEFAULT_TIMEOUT_MS`, the CLI help, and
  the MCP `centrs_discover` tool description still said `60s`. They now agree.

### Changed

- **`release.yaml` fails closed when `NPM_TOKEN` is missing.** A guard step in the
  publish job errors with an actionable message if `secrets.NPM_TOKEN` does not
  reach the runner (whether a repo secret or a tikoci org secret with centrs in
  its repository access) — so a dry-run dispatch proves it before any real
  publish, instead of failing opaquely inside `npm publish`. The value stays
  masked; only its presence is logged.
- **Workflow restructure.** Replaced `docs/specs/`, `docs/WORKFLOW.md`,
  `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, and `work/` with three durable
  surfaces:
  - `docs/CONSTITUTION.md` — the load-bearing rules (validation as product,
    result envelope, error model + URL scheme, settings precedence, identity,
    protocol selection, done = CHR-passed).
  - `docs/MATRIX.md` — command×protocol grid; the only status surface.
  - `commands/<name>/README.md` and `commands/<name>/examples.md` —
    per-command design and executable example list that gates "done."
- Done definition codified in
  `.github/instructions/done-definition.instructions.md`: a feature is done
  when its examples are green on real CHR via `bun run test:integration`.
  Disabling validation to make a test pass is forbidden; validation is the
  product.

### Removed

- `docs/specs/S001`–`S008`, `docs/WORKFLOW.md`, `docs/ROADMAP.md`,
  `docs/ARCHITECTURE.md`, all of `work/`, and the
  `docs-specs-lifecycle` / `work-directory` / `integration-testing`
  instruction files. Their durable content folded into the constitution and
  per-command files; the rest was scaffolding for a workflow that did not
  pay off.
