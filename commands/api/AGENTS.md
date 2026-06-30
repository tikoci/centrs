# commands/api — local constraints + grounded RouterOS facts

This file is the **durable home** for the RouterOS API-behavior facts the `api`
command depends on. It exists so the knowledge survives context resets: a fresh
agent picking up any `api` phase reads this first. Add a fact here only with a
source (a doc URL, a `tikoci/*` project, or a CHR run); follow the global
grounding discipline — one CHR result is a signal, reproduce before treating it as
fact.

Read order for any `api` work: `docs/CONSTITUTION.md` → `commands/api/README.md` →
`commands/api/examples.md` → this file.

## Local constraints

- `api` is the structured one-command-per-operation surface (the verb trichotomy
  in `README.md`). It must not grow code-block / multi-command behavior — that is
  `execute`'s job.
- Reuse the shared cores, do not fork: `src/core/inspect.ts` (the
  `/console/inspect` client) and `src/core/fanout.ts` (the fan-out engine).
- Honor `--via` literally; never silently downgrade transport.

## Grounded facts (doc sources)

REST API — <https://help.mikrotik.com/docs/spaces/ROS/pages/47579162/REST+API> ·
native API — <https://help.mikrotik.com/docs/spaces/ROS/pages/47579160/API> ·
inspect-client TS patterns — `tikoci/lsp-routeros-ts`
(`server/src/routeros.ts` `InspectRequest`, `server/src/validation.ts`).

- **HTTP method map (REST):** `GET`→print, `PUT`→add (**create**), `PATCH`→set,
  `DELETE`→remove, `POST`→universal (run any console command). PUT — not POST — is
  RouterOS's create.
- **Multi-frame results: bounded → array; open-ended → native `/listen` only.**
  *Nuance (do not over-read the REST docs).* RouterOS REST **does** run
  `duration=` / `monitor` commands — it regularizes the native `!re` frames into a
  JSON **array of `.section` records** and returns the whole array in one response,
  bounded by the **60 s** REST cap (a command asked to run longer terminates early
  with an error). Native has **no** such cap. So a `duration=`/`monitor` command is
  an **ordinary bounded `api` call** that returns a `.section` array on both
  transports (native's `talk()` accumulates the `!re` until `!done`) — **not**
  NDJSON. The only thing that needs the NDJSON streaming path is **open-ended
  follow** (native `/listen`, which never sends `!done`); REST genuinely cannot do
  open-ended follow. ⇒ `--listen` (open-ended) is native-only; `duration=` commands
  are normal one-shot calls. (CONFIRMED below.)
- **`/listen` semantics.** Emits `!re` on change; a deleted/disappeared item's
  `!re` carries the dead flag (docs say `=.dead=yes`; **CHR 7.23.1 sends
  `.dead=true`** — see CONFIRMED below); it never self-terminates. Cancel with
  `/cancel tag=<listen-tag>` (the `/cancel` carries its own `.tag`); the listener
  then gets `!trap … message=interrupted` followed by `!done`.
- **Query.** REST `.query` words are **identical to native `?` words minus the
  `?` prefix** (CONFIRMED below). Forms: eq `name=val`; comparison `>name=val` /
  `<name=val` (operator **before** the name); has-property `name`; absence
  `-name`; stack ops `#!` (NOT top), `#&` (AND), `#|` (OR). Multiple words with no
  stack op are **implicitly AND-ed**. See the centrs mapping section below.
- **Proplist.** REST `.proplist` accepts `"name,type"` or `["name","type"]`.
  Native: `=.proplist=name,type`.
- **Object id.** Set/remove by id: REST id-in-URL (`PATCH /rest/ip/address/*1`),
  native `=.id=*1` word. **No native get-one-by-id shorthand** — use
  `print ?.id=*1`. REST has the convenience `GET /rest/ip/address/*1` → a single
  object; native maps it to `print ?.id=*1`.
- **`/console/inspect` request modes** (`InspectRequest` in lsp): `request ∈
  {child, completion, highlight, syntax}`, with `input?`, `path?`, `.proplist?`,
  `.query?`. `child` lists menus/args (path + attribute validity); `completion`
  + `input=` yields allowed values (tips/warnings); `highlight` + `input=` is
  token-level error detection (lsp's primary validator); `syntax` is the parse
  tree.

## Query mapping (centrs `--query` / `--raw-query`)

Two layers, both grounded above:

- **`--query` / `--filter`** — structured convenience, **AND-combined** (RouterOS
  default), repeatable. Each maps to one query word:
  - `name=value` → `name=value` (eq)
  - `name!=value` → two words `name=value`, `#!` (eq then NOT-top)
  - `name>value` / `name<value` → `>name=value` / `<name=value`
  - `name` (no `=`) → `name` (has-property)
  Multiple `--query` emit their words in order; RouterOS's implicit AND applies (no
  `#&` injected). `--query` cannot express OR or arbitrary stacks — that is
  `--raw-query`.
- **`--raw-query <word>`** — power-user escape hatch, repeatable. Each value is a
  **verbatim RouterOS query word** (absence `-name`, OR `#|`, AND `#&`, NOT `#!`,
  or any `>`/`<`/`=` form). Emitted as-is: a `.query` element over REST, a
  `?`-prefixed word over native. centrs does **not** parse or reorder raw words —
  the caller owns the stack. When `--query` and `--raw-query` are both given, the
  structured words are emitted first, then the raw words, in order.

This keeps the common case (`--query type=ether`) clean while giving full
stack-language access without centrs modelling the whole query grammar.

## CONFIRMED ON CHR (Phase 0 grounding spikes — CHR 7.23.1, 2026-06-29)

Probes: scratchpad `api-grounding-spike.ts` (listen/CRUD/execute) and
`api-grounding-spike2.ts` (duration/monitor + query forms + inspect path). Raw
native codec for the listen probe; `fetch` for REST; `connectNativeApi().talk()`
for native.

- **CONFIRMED — native `/listen` + `/cancel`.** `/ip/address/listen .tag=2`
  emits an `!re tag=2` carrying the **full new record** on add; on delete it emits
  a **minimal** `!re tag=2 { ".id":"*3", ".dead":"true" }`. **Correction to the
  docs:** the wire flag is **`.dead=true`**, not `=.dead=yes`. `/cancel =tag=2
  .tag=3` yields `!trap tag=2 {category:2, message:interrupted}`, then `!done
  tag=3` (the cancel) **and** `!done tag=2` (the listen closes). Modern plaintext
  `/login` returns a bare `!done` (no challenge) on 7.23.1.
- **CONFIRMED — native CRUD by id.** `add` returns the new id in `=ret=`; `set`
  and `remove` via `=.id=<id>` succeed with zero `!re` (only `!done`); get-one is
  `print ?.id=<id>` → exactly one record. `numbers=` is **not** needed (that is
  execute's CLI idiom, not the API's).
- **CONFIRMED — query + proplist.** Native `/interface/print ?type=ether` filters
  server-side; `=.proplist=address,interface` returns only those keys. REST
  `POST /rest/interface/print {".query":["type=ether"],".proplist":"name,type"}`
  → `200 [{"name":"ether1","type":"ether"}]` (a complete **array**, not a stream).
- **CONFIRMED — duration/monitor returns a bounded `.section` array (both
  transports).** `POST /rest/interface/monitor-traffic {interface:ether1,
  duration:"5s"}` → `200`, ~5.0 s, a **JSON array of 5 records** keyed
  `.section:"0".."4"` (each `…-bits-per-second` etc.). The native
  `/interface/monitor-traffic duration=2s` returns the same frames via `talk()` (2
  records, each with `.section`) before `!done`. So duration commands are ordinary
  bounded calls, **not** NDJSON. (Corrects the first spike's over-strong "REST does
  not support continuous commands" reading; the `/rest/interface/monitor` 400 there
  was just a wrong command path — `monitor-traffic` is the real menu.) The 60 s
  unbounded cap stays doc-grounded — not worth a 60 s CI wait to reproduce.
- **CONFIRMED — `/console/inspect` `path` is array-typed; pass COMMA tokens, not a
  slash command.** `request=child path=system,license` → children `license:dir,
  export:cmd, generate-new-id:cmd, get:cmd, print:cmd, renew:cmd`; the **slash**
  forms (`system/license`, `/system/license`) return **nothing**. (This is why the
  first spike's license probe was empty — wrong path form.) **Why (rationale, not
  yet re-spiked):** RouterOS's inspect `path` argument is internally an **array**
  type — a comma string like `ip,address,set` is `:toarray`-split into
  `["ip","address","set"]`, the menu walk inspect expects. A `/`-prefixed
  command-style string is **not** an array and isn't split, so it matches no menu.
  A JSON **array** body over REST (`{"path":["ip","address"]}`) should therefore
  work too — **plausible but unconfirmed; do not rely on it.** The contract centrs
  uses is the **comma-joined string** (confirmed; what both `retrieve` and
  `execute` already build via their duplicate `join(",")` helpers — the Phase-1
  `src/core/inspect.ts` is the single home for it). And **`renew` is a `cmd`
  node** → `/system/license/renew` is a write/command, confirming the "streaming ≠
  read-only" rule concretely.
- **CONFIRMED — `.query` forms (REST word == native `?`-word minus `?`).** On
  `/interface/print` (2 interfaces: ether, loopback): eq `type=ether` → 1; ne
  `["type=ether","#!"]` → loopback; OR `["type=ether","type=loopback","#|"]` → 2;
  gt `[">actual-mtu=1000"]` → 2; has `["running"]` → 2; absence `["-running"]` →
  0; implicit-AND `["type=ether","running"]` → 1. Identical results native
  (`?`-prefixed). REST license singleton: `GET /rest/system/license` →
  `{"level":"free","system-id":"…"}`.
- **CONFIRMED — `POST /rest/execute` modes.** With `"as-string":""` it runs
  **synchronously** → `{"ret":"CHR"}`. **Without** `as-string` it is **fire-and-
  forget**: it schedules a job and returns the **job id** (`{"ret":"*18"}`, HTTP
  200) — a `:error` does **not** surface synchronously. ⇒ `api`'s script-POST must
  send `as-string` (reuse execute's `restPost("/execute",{script,"as-string":""})`,
  `adapter.ts:199`) so output/errors are synchronous; the bare async-job form is
  not the default.
- **RESOLVED — `/system/license`** (was inconclusive in spike 1 due to the slash
  path; see the COMMA-path finding above). Independently, `isApiMutating` keys the
  write gate on the method/verb, so even an async/streamable write like
  `/system/license/renew` confirms regardless.

## CONFIRMED ON CHR (Phase 2+3 integration — CHR 7.23.1, 2026-06-29)

Validated by `test/integration/api.test.ts` (rest, examples 1–20, 98 assertions)
and `test/integration/api-native.test.ts` (native, N1–N8, 31 assertions), both
green on CHR 7.23.1.

- **CONFIRMED — native `/execute` supports `=as-string=` for synchronous output.**
  Native `talk /execute =script=…` **without** `as-string` is **fire-and-forget**:
  it schedules a job and returns the **job id** in `=ret=` (observed `"*31"`), not
  the script output — exactly the REST behavior. Adding `=as-string=` (empty value)
  makes it run synchronously and return the captured output, identical to REST
  `/rest/execute {as-string}`. **This corrects `src/execute.ts`'s long-standing
  assumption that native script mode is unsupported** (execute still blocks it; the
  `api` path proves native `/execute =as-string=` works). `api` always sends
  `as-string` for a script run on both transports.
- **CONFIRMED — native CRUD re-mapping to rest-style.** `add` returns the new id
  only in the `!done` `=ret=` word → centrs re-maps it to `{".id": ret}` (REST PUT
  returns the full created object with `.id`; native gives just the id). `set`/
  `remove` reply with a bare `!done` (no `!re`) → no body → centrs surfaces `null`.
  get-one is `print ?.id=<id>` → exactly one record → returned as a single object
  (not a 1-element array). All grounded in `restStyleMutationData` /
  `restStyleRunData` (`src/protocols/adapter.ts`).
- **CONFIRMED — REST `monitor-traffic` over the `api` path returns a `.section`
  array.** `POST /rest/interface/monitor-traffic {interface,duration}` →
  `[{".section":"0",…}, {".section":"1",…}]` (re-confirms the spike-2 finding via
  the real `api` REST adapter). It is a command (terminal verb `monitor-traffic`,
  not `print`/`get`), so it is a `POST` and **write-classed** → needs `--yes`.
- **CONFIRMED — the inspect gate over both transports.** Path existence
  (`request=child` empty ⇒ `validation/unknown-path`) and add/set attribute
  validity (`request=child`+`completion` ⇒ `validation/unknown-attribute`) fire
  identically over rest-api and native-api, **before** any write — no `:put
  [:parse]` involved (api input is a path, not a CLI string). A `/execute` script
  is a CLI string ⇒ `meta.validation.semantic = "not-applicable"`.
