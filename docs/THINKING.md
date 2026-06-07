
# Loose notes from Humaan to track/plan FUTURE agent prompts

**Items here should NOT be consider decisions, rather items the human is tracking and "thinking about".**

---

I'd like to clean up the command specs.  i have some comments below i'd like you to review, and also review our all current docs/specs for open questions - both already noted and identify any **unasked** questions from your POV that might clarify or rationalize but not already tracked.  or where any of the comments below conflict or you think a "bad idea".   basically i want to solidify our specs more before future work.  below are initial thoughts, not directives.  use your own best judgement. think about what **you** think is missing the specs that prior agents may not have tracked as an open questions.  so review all docs/specs, form your opinions, and **ask me anything** that might further our goals and provide better/clear guidance to future agents when coding as well as providing a good/"natural" UX to both humans and agents.

---

## discover
- default should be 15s and start with refresh
- perhasp save should be default, so a --no-save may be better and/or devices uses some "devices --discover"/"devices discover" => IDK exactly, looking for input, but core problem is UX since discover would populate devices so centrs and perhaps steer toward providing a default user/password so the eventual setup steps are clean and centrs "starts useful"
- Some "CLI only" (e.g. interactive tty?) text output outside the envelope suggesting discovery in possible when started as no output looks "hung" since it's unclear what a plain "centrs discover" does => IDK exactly "best" since it better if everything did follow envelope.
- open: how to handle set default for discovery like discovery time and if it should automatically save...  perhaps kv to store when for aging out --save entries and timeout
- other operations should have tip to steer toward discover if CDB is empty
- should store version and board from MNDP as a KV so centrs/agents know model if known from MNDP or "centrs check"
- open: promation from discover? IDK how, but feel like some "move group" from discovered with perhaps adding user/password.  IDK best, so looking for your thoughts.
- open: mac as default from discover? that is more unique than even IP?  maybe i made the wrong call earlier?
- open: routeros has software id and license id (for chr), IDK if in MNDP, if not let track that storing the software/license ID could eventually done via `check` since that should be the "most unique" identifier, which could be useful to know

---

## retrieve
- review design...
- how to handle async commands / "print follow" etc. is unknown, since they can stream data... so how to put a friendly wrapper over retrieval is still TBD IMO, and command spec lack tighting.  
- perhaps some `tail` or `stream` command, IDK, but that wraps the async-style (e.g. RouterOS command has a `once`/`follow`/`duration=`/`freeze-frame-interval=`) commands, since something like "print follow" allow streaming of results. 
- => basically review and give some though on tighting and improving retrieve operations, and how it fits with execute... so it UX and logic make sense wholestically

---

## code review

There is a Linux t linux tool `jo` that handles KV on Linux shell prompts, perhaps some learnings we can apply.  please review it's logic to see how well we align with it since I'd imagine there are a lot of corner hased in using KV as shell args.  See https://github.com/jpmens/jo

---

## devices and groups...

In a quick review of "centrs devices", somethings are "uneven" and we lack full group operators.  IDK the right method/scheme ATM, but somethings like below are missing:
- remove --group X
- add --all = all CDB entries
- add --default = __default__

## --help & help system generally

- on devices, level aware (e.g. on `centrs devices remove --help` and similar should be more specific than `centrs devices --help`)
- should have tip for "did you mean?" for similar commands/options
- skills.md from routeros-skills reformed as detailed docs (e.g. MNDP) <- should be even more grounded and targeted than skill

---

## Refinement log — pass 1 (2026-06-06, agent)

Outcome of the review the human requested above. The loose notes stay verbatim;
this section records what was **decided**, what was **fixed**, what is **proposed
pending approval**, and what is **still open**. Decisions here are not yet folded
into the constitution (that is a deliberate, separate pass — see "Proposed").

### Decided

- **`discover` save model.** Bare `centrs discover` is read-only (envelope only;
  never writes the WinBox-shared CDB); `--save` is explicit. `centrs devices
  discover` **implies `--save`** (invoking the registry surface means you intend
  to operate on it) and is the home for the "steer toward default creds"
  onboarding nudge. The write still routes through the `devices` write layer, so
  "devices is the only writer" holds.
- **`discover` defaults.** Default window `15s` (was 60s) and **emit the refresh
  broadcast immediately** (don't wait for the first 5s tick), then refresh every
  5s. Short window is fine because centrs actively solicits replies.
- **Streaming = a new `stream` verb (NDJSON).** Not `retrieve --follow`: the
  envelope-vs-stream difference is a contract boundary, and folding it into
  retrieve would force every retrieve consumer to handle "maybe a stream."
  - Canonical `stream`; `tail` is a log-scoped alias (`centrs tail <r> /log`).
  - **Read-only, validated like retrieve** (path-shaped → `/console/inspect`).
    Interactive PTY stays in `terminal`; bounded single-shot stays in `retrieve`
    (`--once`).
  - **Frame contract:** each NDJSON line is one envelope; the stream is
    terminated by a final **summary envelope** (frame count, duration, stop
    reason). A mid-stream error is a frame with `ok:false`; the process exit code
    reflects whether the stream *started* cleanly.
  - **Transport:** true follow **cannot ride REST** (RouterOS REST 60s hard cap),
    so `stream` is **native-api / ssh-first**; over `--via rest-api` it is
    bounded-or-rejected. Wraps RouterOS `once`/`follow`/`duration=`/
    `freeze-frame-interval=`.
- **Liberal target-selector grammar (everywhere).** All non-terminal commands
  accept N `<router>` positionals + repeatable `--group` + `--all` (every CDB
  record) + `--default` (`__default__`), de-duped by CDB record index;
  destructive multi-target needs `--force`. `terminal` (and single-stream
  `stream`) reject N>1. This resolves the retrieve↔devices fanout conflict in
  favor of devices' liberal model.
- **`--max-results` split** into `--max-bytes` (byte budget) and `--max-rows`
  (row count, retrieve only), both truncate-with-warning + `meta.truncated`
  (`ok: true`), never a pre-flight error.
- **No auto-aging / auto-deletion of `--save` CDB records.** centrs deleting
  records from a WinBox-shared file is unsafe. Discovery timestamp is already
  stored as provenance; surface staleness as a **tip**, not a delete.
- **MAC stays a lookup key, not the `target`.** Earlier call was right: `target`
  should be the *connectable* literal (IP works directly over REST/native; MAC
  needs L2). Uniqueness is already handled by the **MAC-keyed de-dupe** + MAC
  lookup key. (Answers the "did I make the wrong call?" note.)
- **stderr is sanctioned anywhere, used sparingly** (most ops are fast). It is
  the channel for discover progress and TTY prompts, exempt from the
  lossless-envelope rule. Needs a one-line constitution amendment (Proposed).
- **`devices remove --group G`** already exists (requires `--force`) — not
  missing, just not discoverable. (Help-system item, below.)
- **Help system:** level-aware help (per-subcommand, e.g. `devices remove
  --help`) and "did you mean?" suggestions (extend `input/invalid-command`,
  which already lists canonical verbs + aliases) — both approved, low-risk.

### Fixed in this pass (doc conflicts A1–A4)

- **A1** `README.md`: removed the stale "the comment is *not* a lookup key" claim;
  it now documents `identity=`/`mac=`/`ip=` resolution.
- **A2** `commands/retrieve/README.md`: deleted the `--group` "mutually exclusive
  with a positional" rule (flags table + Group-fanout prose) → liberal selectors.
- **A3** `commands/devices/README.md`: documented the intentional two-path split —
  reserved token in a parsed comment → `cdb/reserved-option` *warning* (inert);
  reserved key as a `devices set` positional → `cdb/reserved-key` *error*.
- **A4** `commands/retrieve/README.md` + `commands/execute/README.md`: split
  `--max-results` → `--max-bytes` / `--max-rows`; reconciled the
  error-vs-truncate contradiction toward truncate-with-warning everywhere.
  (Note: this aligned `execute`'s old "fail if exceeds" to truncate for one
  coherent model — veto if you wanted execute to hard-fail instead.)

### Folded in (applied 2026-06-06)

Approved and applied to the real specs (constitution + command files + matrix):

- **stderr channel** — constitution Result-envelope note: losslessness covers
  stdout only; stderr carries progress + prompts, used sparingly.
- **Target-selector grammar** — new constitution subsection (positionals +
  repeatable `--group` + `--all` + `--default`, dedupe by record index, `--force`
  for destructive multi-target, terminal/single-stream reject N>1). retrieve's
  old mutual-exclusion already removed in the conflict-fix pass.
- **`stream`** — constitution protocol-selection row + rule, new
  `commands/stream/README.md`, `docs/MATRIX.md` row (`designed` for
  native-api/ssh), and execute's async open-question resolved (points to stream).
- **`devices discover`** (save-implied) — `commands/devices/README.md` sub-verb +
  `commands/discover/README.md` (15s default, immediate first refresh, read-only
  bare `discover` vs save-implied `devices discover`).
- **Config: `centrs.env`** — constitution Settings-precedence tier 2 made
  concrete: `${XDG_CONFIG_HOME:-~/.config}/tikoci/centrs.env`, dotenv-style
  `CENTRS_*=value`, read as tier-2 *defaults* (below real env at tier 4, so
  centrs does not inject into `process.env`), **optional** (missing = not fatal,
  built-in defaults apply), **no new dep** (plain `KEY=value`), and **not** an
  inventory/credential store. Decides where global discovery defaults live;
  per-device settings stay in the CDB. (`centrs config` get/set helper is a
  later convenience, not required — hand-editing the file works.)

### Still open (tracked, not yet decided)

- **First-run onboarding.** Empty-CDB → working state: how `devices discover` +
  `__default__` + cred entry chain into a "starts useful" first run.
> Perhaps we should consider some "centrs config" where its interactive to collect user/password (optionally), confirm/update settings, etc. and generally be the front end to the centrs.env and/or __default__ etc.  perhaps some "centrs config set|get|reset|print [<attr>] [<value>]" for non-interactive use.  so eventual instruction steer towards config
- **`check` writing facts back.** If `check` stores version/board/software-id it
  must route through the `devices` write layer (like `discover --save`), and we
  must decide *inert provenance* vs *queryable derived keys*.
> the version/board/software-id should be queryable/selectable in the fullness of time, so whether check needs to do as thing, no.  but general idea of check is there is some `--fix` that would "correct" things like ports using the connected devices (e.g. if got in via MAC address, it can then find out the API or REST API port, so CDB have the port as part of the comment KV)
- **MNDP board/version/software-id: inert vs queryable.** Today inert
  free-form provenance. Promoting to queryable keys is reasonable but they are
  *facts* (can go stale), not *settings* — keep in a separate "derived/may-be-
  stale" namespace if promoted; never let them override a live read. software-id
  is in MNDP; license-id is not (CHR-only, via `check`). These are *verification*
  fields, not resolution keys (you don't type them to reach a box).
> correct software-id is a verification key, license-id may in fact just be metadata to match against MikroTik CHR licensing page "by hand" as a convience.  yes it can go stale, so perhaps comment kv need some kinda last updated.  and/or perhaps some --check on device add/set.  But for example, you may want to do "centrs execute --query board=RB5009 /system/package/check-for-updates" to perform some operation on a class of devices, other than group  
- **Row selection.** `retrieve <router> <path> <.id|name>` is in the synopsis but
  has no example and no stated relationship to `--query`/`--filter` (not-impl).
  Settle "read one row by name" before SNMP/stream pile on.
> IDK either yet.  but certainly need figure out out before touch/thinking-about SNMP/stream.  ideas?
>> RATIFIED 2026-06-06 (human): flag-only. Drop the `<.id|name>` positional;
>> `--query`/`--filter` always return an **array** (`--query name=ether1` is how
>> you read one row, len 0..1) — no singleton-by-name shape. Folded into
>> `commands/retrieve/README.md`. Related: `--once` (bounded monitor-style single
>> read; open follow is the `stream` verb) is now stubbed in retrieve's flags.
- **Promotion workflow.** Express "discovered → managed" via `devices set --group
  … --user … --password …` (no new verb); the only gap is a **bulk** form, which
  falls out of the liberal selector grammar applied to `set`.
> This make sense
- **`devices set key=` (empty value) semantics** — unspecified. jo maps empty →
  null; centrs's internal `CommentKvUpdate{value:null}` *removes* the token. Pin
  whether CLI `set foo=` removes the key or sets it empty.
> i think it removes it unless good reason for alternative logic
- **jo learnings.** centrs's KV is intentionally *safer* than jo: the allowlist
  gives each key a known type, sidestepping jo's central type-guessing
  ambiguity. No string-forcing escape needed for RouterOS command args
  (REST tolerates strings; native-API is all-strings). Confirm `execute` passes
  attribute values through verbatim (no coercion guessing).
> sound good.  just though it a chance to review parsing logic.
- **skills-vs-docs boundary.** centrs docs should document *centrs behavior* +
  CHR-grounded specifics; the `routeros-*` skills remain canonical for protocol
  wire formats (e.g. `routeros-mndp`). Define the boundary so the two don't drift.
> more that the typedoc should at least have the TLV structure and attributes value documented so that agents do not depend on the SKILL. maybe nothing to do.
- **`tip/no-devices` extension.** Fire the same empty-CDB tip on `retrieve` /
  `execute` when resolution fails (already exists on `devices list`).
> sound right

### Code follow-ups (spec now leads code, after this pass)

The pass-1/2 edits moved the spec ahead of `src/` in a few places. None block the
current `CHR-passed` cells; they are the implementation backlog the new specs imply:

- **discover default 60s → 15s + immediate first refresh.** `src/discover.ts`
  (`DISCOVER_DEFAULT_TIMEOUT_MS = 60_000`) and `src/cli/discover.ts` help text
  still say 60s; the listener also broadcasts on the 5s tick, not immediately.
  Tests pass explicit timeouts, so the constant change is test-safe; the
  immediate-refresh is a small listener-loop change that wants its own test.
> doc should reflect reality, but perhaps not update readme.md as a impl task
> **IMPORTANT NOTE**  on integration tests for discovery... one option that has not been considered is enabling "socket" networking with `quickchr` for integration tests, since we should be able to forward 6789 broadcast over added socket network to quickchr while using usermode network for REST/API via port forwarding. see quickchr help.
- **`--max-results` → `--max-bytes` / `--max-rows`** in `retrieve`/`execute` code,
  plus reconcile the now-likely-orphaned `docs/errors/input/max-results-exceeded`
  error page (truncate-with-warning replaces the pre-flight error; per the
  constitution, retiring a code needs the Pages entry removed + a redirect).
> we have no customers, so we can remove the nasent page without redirect if easier.  leave consitution alone but okay to override here to avoid starting with clutter but once operational constitution is correct.
- **Liberal selector grammar** (`--all`, `--default`, repeatable `--group`,
  positionals + group combinable, `--force` for destructive multi-target) wired
  uniformly across commands.
> correct
- **`centrs.env` tier-2 loader** — read `${XDG_CONFIG_HOME:-~/.config}/tikoci/
  centrs.env` as *defaults* (applied below real `CENTRS_*` process-env), optional.
> perhaps tests or your dev agent usage needs to some --skip-env-file to prevent them being used
- **`stream` verb** implementation (first consumer of the native-api streaming
  reader) and **`devices discover`** sub-verb wiring (save-implied).
> we likely need to some spike to confirm native api is solid, and starting stream should happen after retrieve is further along and reviewed again for UX
