# api

A structured RouterOS **API passthrough**, modeled on `gh api`. You give it a
REST-style endpoint path and an HTTP method; centrs fills in credentials from the
CDB / env / flags, validates the request through `/console/inspect`, runs the
single REST or native-API operation, and returns the result in the standard
envelope.

Status: `CHR-passed` over `rest-api` and `native-api`, including multi-target
fan-out and open-ended `--stream` follow (native-api only), per
`docs/MATRIX.md`. This file describes intent and flags; the matrix holds the
cell states. Load-bearing rules — envelope, errors, settings precedence,
identity, validation, protocol selection — live in
[`docs/CONSTITUTION.md`](../../docs/CONSTITUTION.md); the `(constitution: …)`
notes below point there rather than restating them.

`api` absorbs the former `stream` command: open-ended follow is `api <router>
<endpoint> --stream` (or the `/listen` endpoint form). `--listen` is an accepted
alias of `--stream`. Streaming is single-session — it cannot combine with
multi-target fan-out (see below).

## Where `api` sits — the verb trichotomy

centrs has three RouterOS-touching verbs; pick by shape of work, not by habit:

- **`execute`** — the CLI-like runner. The full RouterOS console surface
  (multi-command / script blocks, console-text output, `:put [:parse]` gate). Most
  powerful and lowest-level, but the caller authors a RouterOS CLI string and the
  output is console text.
- **`retrieve`** — read-only data extraction. Discoverable, structured-out,
  always read.
- **`api`** (this command) — the structured middle. Enforces the
  *one-command-per-operation* semantics of the REST / native API (no code
  blocks), **can write**, and forces structured input **and** output. For an AI
  agent this is usually the friendliest write path: no CLI-string authoring,
  structured in/out. It does **not** replace `execute` — console-only and
  multi-command work still needs `execute`.

## Synopsis

```text
centrs api <router> <endpoint> [flags]
```

- `<router>` — IP, DNS, MAC, or CDB-resolved identity (constitution: identity).
- `<endpoint>` — a REST-style path, leniently normalized. All of
  `ip/address`, `/ip/address`, `rest/ip/address`, `/rest/ip/address`,
  `"ip address"`, `'ip address'` canonicalize to `/ip/address`. A trailing id
  segment (`ip/address/*1`) addresses one row. A trailing `/listen` segment
  infers `--stream` + `--via native-api`.

The HTTP method (`-X`, default `GET`) is honored **literally** against RouterOS's
REST mapping — `GET`→print/get, **`PUT`→add**, `PATCH`→set, `DELETE`→remove,
`POST`→run-any-command. Note the trap: **`PUT` is RouterOS's create**, not
`POST`. centrs never rewrites your method, but warns (`tip/rest-verb-mapping`)
when a bare-collection `POST` carries create-looking fields.

## Flags

| Flag | Behavior |
| ---- | -------- |
| `-X` / `--method <verb>` | HTTP method, default `GET`, case-insensitive. |
| `-f <key=value>` | String field, repeatable; assembled into the JSON body. Values pass through verbatim (no type-guessing). |
| `-d` / `--data <json>` | Raw JSON request body. Collides with `-f` → `usage/conflicting-flags`. |
| `--input <file\|->` | Read the raw JSON body from a file or stdin (`-`). |
| `--query` / `--filter <expr>` | RouterOS-side row filter, AND-combined, repeatable. `name=value` (eq), `name!=value` (ne), `name>value`/`name<value` (cmp), `name` (has-property). Maps to REST `.query` words / native `?` words. |
| `--raw-query <word>` | Verbatim RouterOS query word (repeatable) for OR / absence / stack expressions — e.g. `--raw-query type=ether --raw-query type=vlan --raw-query '#\|'` (OR). Emitted as-is; the caller owns the stack. |
| `--attribute` / `--proplist <a,b>` | Property projection → `.proplist`. |
| `--raw` | Strip the envelope; emit bare RouterOS JSON. Implies `--validate=false`; does **not** imply `--yes`. |
| `--yes` | Confirm a mutating (non-read) request in non-interactive runs. |
| `--stream` (alias `--listen`) | Native-api-only open-ended follow → NDJSON stream of envelopes, ending with a summary envelope. Inferred from a `/listen` endpoint. `--via rest-api --stream` errors `transport/capability-unsupported` (REST's 60 s cap cannot follow). |
| `--duration <dur>` / `--count <n>` | Bound a `--stream`: stop after a wall-clock window / after N frames. |
| `--validate[=false]` | Default `true`. Gate is `/console/inspect` (see Validation). |
| `--via <protocol>` | `rest-api` (default) or `native-api`. No silent downgrade. |
| `--format <json\|yaml\|text>` | Output format. Defaults to `json` for `api` (machine-first); `CENTRS_FORMAT` overrides. Under `--stream`, `json`/`yaml` emit one compact envelope per line (NDJSON); `text` emits a concise row per frame. |
| `--group <name>` / `--where <attr>=<value>` / `--near <lat>,<lon>,<radius>` / `--bbox <south>,<west>,<north>,<east>` / `--all` / `--default` / `--concurrency <n>` | Multi-target fan-out (see below). Repeatable `--group`/`--where`; `--near`/`--bbox` select by device GPS (lat-first; see constitution: target selection). The union de-dupes by CDB record index. |
| `--quickchr <name>`     | Target a running quickchr-managed CHR VM by name: host/port/auth come from the live descriptor (`@tikoci/quickchr` 0.4.4+, optional dependency), bypassing CDB/env resolution for those fields. Repeatable — repeating fans out. Exclusive of `<router>` positionals and CDB selectors; conflicts with `--host`/`--port`/`--username`/`--password` (constitution: resolution providers). |
| target/auth | `--host`, `--port`, `--username`/`--user`/`-u`, `--password`, `--insecure`, `--timeout`, `--cdb-file`, `--cdb-password`, `--resolve <none\|arp>` — same single-target resolver as `retrieve`/`execute`. |

## Fan-out (multi-target)

Selecting more than one router — any selector flag (`--group` / `--where` /
`--near` / `--bbox` / `--all` / `--default`) or more than one positional target — switches `api` into
**fan-out mode** (`src/api-fanout.ts`, on the shared `src/core/fanout.ts` engine
and the `src/resolver/selection.ts` grammar). A plain single-positional call
stays the single-target envelope. Output is the locked `FanoutData` envelope
(`data = { summary, targets[] }`; outer `ok` = orchestration success; per-target
failures are inner `ok:false`), and the process exit code is granular: `0`
all-ok, `2` partial, `1` orchestration error or every target failed. See
`docs/CONSTITUTION.md` (Target selection) for the shared grammar and `--where`
vs `--query` distinction.

- **Writes fan out under `--yes`**, confirmed once up front (not per target).
  Without `--yes`, the error names the blast radius (how many routers) and that
  `--yes` is required.
- **`--listen`/`--stream` is single-session** → `usage/fanout-not-supported` in
  fan-out mode. **`--raw` strips the envelope** → `usage/conflicting-flags` in
  fan-out mode (per-target envelopes can't be bare).

## Validation

Default on. Because the input is a structured path (not a CLI string), the gate is
`/console/inspect` — **not** `:put [:parse]`:

- Path existence + per-verb attribute validity via `request=child`
  (`validation/unknown-path`, `validation/unknown-attribute`).
- Value-level advice via `request=completion` (+`input=`) feeding `tips`/`warnings`.
- **Carve-out:** a script-shaped `POST /rest/execute` is a CLI string, not a path,
  so the inspect gate is `not-applicable` (`meta.validation.semantic`); RouterOS
  re-validates on the run.

`--validate=false` (and `--raw`, which implies it) skip the preflight; RouterOS
still re-validates writes server-side. Disabling validation to make a call pass is
forbidden (constitution: validation is the product).

## Write confirmation

Read-only **iff** the method is `GET`, or the endpoint terminal verb is
`print`/`get`, or it is `listen`. Everything else is treated as a write and needs
confirmation (`--yes` non-interactively, or a TTY prompt) → otherwise
`usage/confirmation-required`. Two consequences:

- A `POST …/print` paged read does **not** prompt (keyed on the verb, not the
  wire HTTP method).
- Streaming does **not** imply read-only: an async-but-mutating command like
  `/system/license/renew --stream` still confirms.

`--raw` does not bypass this gate.

## Output

Always rest-style JSON in the standard envelope (constitution: result envelope).
Over native-api the records are re-mapped to the same rest-style shape, with string
values (the binary API carries no JSON scalar types).

`--raw` is the bare-passthrough escape hatch (the envelope-lossless rule is waived
for it): success prints only the RouterOS body on stdout; a RouterOS error prints
the RouterOS error payload to stderr with a nonzero exit; a centrs-side failure
with no RouterOS response prints a compact `{code,message}` to stderr. Exit code is
`0` iff `ok`.

## Multi-frame results: bounded vs open-ended

RouterOS produces multi-frame output two ways, and `api` treats them differently:

- **Bounded `duration=` / `monitor` commands are ordinary `api` calls.** Both
  transports return the accumulated frames as a normal **array** (REST regularizes
  the native `!re` frames into `.section`-keyed records; native's reader collects
  them until the command completes). No flag needed — e.g.
  `centrs api $R interface/monitor-traffic -f interface=ether1 -f duration=5s`
  returns a `.section` array. REST bounds these at the **60 s** cap (a longer
  `duration=` terminates early with an error); native has no cap. This is **not**
  NDJSON.
- **Open-ended follow is `--stream` (alias `--listen`), native-api only.** Only
  the native API `/listen` command follows indefinitely (REST cannot — the 60 s
  cap). Each `!re` becomes one rest-style envelope frame (one NDJSON line; a
  deletion's `.dead=true` flag is preserved); the stream ends with a summary
  envelope (`data.stopReason` ∈ `count-reached`/`duration-elapsed`/`interrupted`/
  `transport-error`, plus `frames` and `durationMs`). `--duration`/`--count`
  bound it; Ctrl-C stops and still emits the summary. `--via rest-api --stream` →
  `transport/capability-unsupported`. The exit code reflects whether the stream
  *started* cleanly, not whether every frame was `ok`.

## MCP (deferred — forward guidance)

`api` is **not** exposed over the MCP frontend yet: the MCP server is the
least-mature surface, and a raw passthrough sits awkwardly against its "scoped
verbs, never one tool per RouterOS command" model. But precisely because `api` is
structured and agent-friendly, it is the strongest *future* MCP candidate for an
agent driving RouterOS — to be revisited behind the per-device `mcp=ro|rw` +
`confirm:true` write gate (method-aware: read verbs `ro`, everything else `rw`) and
the CDB-as-allowlist authorization model (constitution: MCP surface).

## Definition of done

`CHR-passed` only when every example in `examples.md` runs green against a real CHR
through `bun run test:integration`. See
[`docs/CONSTITUTION.md`](../../docs/CONSTITUTION.md) for the full done rule.
