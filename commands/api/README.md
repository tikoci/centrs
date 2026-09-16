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

Implemented flags are generated from the CLI metadata into
[`docs/CLI.md` → api](../../docs/CLI.md#api); this file does not duplicate
that table, and `api` has no designed-but-unimplemented flags. Behavior notes
the generated reference cannot carry:

- `-f` values pass through verbatim (no type-guessing); `-d`/`--input`
  collide with `-f` → `usage/conflicting-flags`.
- `--query`/`--filter` map to REST `.query` words / native `?` words.
- `--raw-query` is emitted as-is; the caller owns the stack — e.g.
  `--raw-query type=ether --raw-query type=vlan --raw-query '#|'` (OR).
- `--via rest-api --stream` errors `transport/capability-unsupported`
  (REST's 60 s cap cannot follow).
- Under `--stream`, `--format json`/`yaml` emit one compact envelope per
  line (NDJSON); `text` emits a concise row per frame.
- The target/auth flags (`--host`, `--port`, `--username`, `--password`,
  `--insecure`, `--timeout`, `--cdb-file`, `--cdb-password`, `--resolve`)
  use the same single-target resolver as `retrieve`/`execute`; `--quickchr`
  resolves host/port/auth from the live `@tikoci/quickchr` descriptor
  instead (constitution: resolution providers).

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

Default on. Because the input is a structured path (not a CLI string), the device
gate is `/console/inspect` — **not** `:put [:parse]`:

- Path existence + per-verb attribute validity via `request=child`
  (`validation/unknown-path`, `validation/unknown-attribute`).
- **Designed, not implemented:** value-level advice via `request=completion`
  (+`input=`) feeding `tips`/`warnings`. Whatever implements it must not fall
  back to `request=completion` at a *command* path (`path=` ending at the verb):
  that shape hangs REST and closes native API on RouterOS 7.12.2, and no centrs
  code uses it. Completion at an *argument* path (`print,proplist`, as `retrieve`
  does) answers normally on the same build. See the 7.12.2 finding in
  `AGENTS.md` (GH#343).
- **Carve-out:** a script-shaped `POST /rest/execute` is a CLI string, not a path,
  so the inspect gate is `not-applicable` (`meta.validation.semantic`); RouterOS
  re-validates on the run. Until GH#354 that carve-out meant the script was sent
  with *no* preflight at all. It is now gated by the offline stage (constitution:
  validation) — the same analyzer `explain` publishes, run over the `script`
  field with no connection, so a syntax fault is a byte span in
  `error.context.span` instead of a round trip. `meta.validation.stages[]` shows
  the offline stage `passed` and the device stage `skipped` with its reason. A
  missing or blank `script` is still `input/invalid-command`, not a syntax
  rejection.
- Structured path requests are **not** offline-gated. The input is a path plus a
  body, not a CLI string, and an offline *path* gate collides with GH#211's
  unlisted-path decision. On the success path `meta.validation.stages[]` is
  absent there; on a `validation/*` rejection it is present and reports the
  offline stage `skipped` with that reason, so the breakdown never implies an
  analysis that did not run.

`--validate=false` skips **both** stages of the preflight — one flag, one meaning
(constitution: validation); RouterOS still re-validates writes server-side.
Disabling validation to make a call pass is forbidden (constitution: validation
is the product).

`--raw` **defaults** `--validate` to false — it does not override it (GH#154).
The resolution order is the explicit `--validate` flag, then `--raw`, then
`CENTRS_VALIDATE` / the CDB comment-kv / config, then the `true` default. So
`--raw` alone behaves as it always has and behaves the same on every machine
whatever the environment holds, while `--raw --validate=true` runs the gate and
reports a rejection in the `--raw` error shape (`{code,message}` on stderr,
nonzero exit, no `data` key) — which is how you debug `api` when centrs itself is
the suspect.

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
