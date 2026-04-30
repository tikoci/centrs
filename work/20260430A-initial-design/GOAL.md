# Start of "centrs" => API/CLI/TUI/MCP/webproxy (+ SQLite caching)

This is a new tikoci project designed to be a `bun` based library and CLI, as well as HTTP server that can proxy request to a RouterOS device accepting HTTP/s, but exposing similar interface to CLI/API including CORS over REST API and OAuth/passkey and user-manager support for auth, and also MCP (potentially - <small>Excellent docs/types/library, agent-friendly API/CLI with a "SKILL.md" to is part of MVP, that may mitigate need for MCP.</small>).  A sort of "monorepo" that does work as one things, but totally okay/expected parts may be vendored/shipped separately.  But like one unified codebase that has a handle on RouterOS interaction though a more regularized scheme than raw commands to MikroTik API.  A non-goal is wrap RouterOS configuration in friendly functions (so NO createVlanOnBridge() things) => we help human/agent by "checking" existing RouterOS syntax BEFORE it's used, with full knowledge of RouterOS schema from other TIKOCI projects... so we offer up good help on what not valid so as long as closer was "close", we can help.  Future SKILL.md things can explain **using** us to do RouterOS config things SO were a "friendly conduit" to RouterOS that bakes in a lot "weird" RouterOS things so called/user/agents can focus on the CLI to run, not the protocol/ports/auth/etc/etc needed on top.  This is why we have many "frontends", since we NOT involved in _what_ operation your doing.  

Concepts:

- Allows both "curated" and direct access to RouterOS devices, using multiple access protocols
- Has cache in SQLite, including hash auth, so NOT pure "API wrapper"
- Agentic AI friendly
  - Discoverable CLI - "MCP like interface"
  - Lib Code with JSDoc/SKILL/etc - anything to help agent understand API interface quickly
    - Consider: _I am not an agent, so cannot spec directly, consider you’re an agent who in future who may be a user of the API in bun tests and need to figure out how to use this to interact with RouterOS (e.g. what would cause you to use this API vs. just using curl/python/Bun.fetch/ssh directly (i.e. my answer why? => Because we know the ports, username/passwords, and can check commands before running to deal with training data giving "mixed signals" on what RouterOS commands are valid - all stuff an agent have to solicit or find somehow -> less tool calls, more accurate way to interact)
  - Included SKILL.md on usage to fill in any gaps or be pointer/container
    - Same considerations: _I am not an agent, so "balancing" what’s in JSDoc/comments/types vs SKILL.md IDK a priori.  Since skills have to be loaded in some context, I lean towards clear TS types and JSDocs over SKILL.
- Knowledge of Mikrotik formats for device/password.  So WinBox CDB and dude.db be source of "Groups" and "Devices", so the data side is also multi-protocol and cached/file-based/ENVs generally tracking Dude Devices and Maps [groups] schemes
- Most of the code will be vendored from other tikoci projects.  
- CLI ARG and ENVs are equivalents, so anything can be provided via ENV **or** CLI arg **or** TUI
- The idea is both be a "code warehouse" for RouterOS TypeScript code & a functional library/CLI/TUI around RouterOS.
- Project is already a "populated strawman" so it express many preferences, adjust as needed.

Engineering Practices:

- Everything is `lint`, not just TS.
  - GitHub Actions
  - Markdown aligned around:
    - "Agentic AI files" like SKILL.md/instructions/plan.md/etc. limited linting to **actual** signals of problems like bad #fragments/URLs, etc, **not** stylistic choices like long-lines or emphasis-as-header, these likely should be okay in agencies files)
  - etc.  see other files in repo for ideas

AI Setup

- Support multiple agents, but system generally aligned around CoPilot schemes, others get points.  
  - So using AGENTS.md, and but also directory level ones
  - (copilot-instruction.md points to AGENTS.md to be explicit, even thought it _should_ use AGENTS.md, short copilot-instruction.md that repeats that okay)
  - CLAUDE.md points to overview of key files, but it not a store of information other than "pointers" specific for Claude Code
  - Like .copilot/instructions with scoped applyTo to control context-bloating, so using .claude/rules using `paths`, which copilot should treat in similar way (please confirm someplace and work with claude ecosystem.  could pivot back to .copilot `applyTo` scheme if needed - but like small narrowly scoped instructions that are carefully crafts to "get the right info, in the right places"... likely still many will get loaded, and thought is that okay.  since many files with long names is actually easier to "audit" for human.
  - Should liberally use project-level SKILL.md for processes, scoped instructions pointing project skills as needed
- Including SKILL to help maintain and review the AI system itself used is aligned
- Script-based generation of human friendly docs, so thing like typedoc etc and/or schema views and/or CLI framework that has good metadata for docs — ideally large parts of the doc should be generated rather agent copying details in various places....  code should

From a CLI POV, it look something like this:

- `execute <device|group> …` (mainly borrowing quickchr’s "exec") be a key one
  - keeping --via concept of multi-protocol support, but with expanded options (see access options below)
  - adding a `—no-validate` since we should by default check the command is valid using `[:parse]` (see lsp-routeros-ts).  This would be the primary entry point
- `terminal <device|group> …` (similar to execute but brings up a GUI/shell)
  - WinBox Terminal
  - WinBox Application Launch
  - SSH
  - Telnet
  - MAC-telnet
  - RoMON
  - Notes:
    - Using a group implies using tmux, only available if `tmux` is available otherwise error
    - API supports wiring up file-describer (e.g. use in VSCode extension to terminal)
- `retrieve <device|group>` (fetch a value from RouterOS)
  - Essentially either a GET if attribute or POST if path, without extra RouterOS semantics - just path with get/print and optional attribute
  - Also supports SNMP retrieval `retrieve snmp <OID | MIB-name>`with —community
  -  
- `update` (set a value on RouterOS)
  - Essentially a PATCH or POST
- `check` (ICMP to RouterOS device by centrs name, or IP/MAC)
  - Show arp
  - Include —mac-ping (use ARP to find MAC, info if not able)
  - Include —traceroute (runs a trace router
  - Assumes 10 pings collecting stats (buffer bloat)
  - options names borrowed from /tool/netwatch type=icmp
  - Report if seen MNDP (trigger MNDP, and collect MNDP while pinging)
  - Show open management ports
  - User/ip/port/protocol
    - Resources
    - Health
    - License
    - Services
    - Device-Mode
    - Interfaces
    - IP/IPv6 Address
    - Routing
- `upload <device> <local> <dst>`
  - Uses rest api to download if small
  - Uses scp or sftp to download if larger
  - Starts a temporary web server to `/tool/fetch from RouterOS side to cause an upload
- `download <device> <RouterOS-path> —output xxx —search-all-paths`  
  - If file is not at path, and —search-all-paths is used, should locate a file same **same** name, if single return it, other wise error with friendly error message
  - Uses rest api to download if small
  - Use s"back to home files" if enabled
  - Uses scp or sftp to download if larger
- `devices` (shows discovered and stored RouterOS devices),
        - Sources:
            - MNDP
            - .cdb from WinBox
            - dude.db
  - Prompts for password, or one can be in the .env file, or .cdb can be plain-text which does not need one
  - Db provided for by args or user settings
  - —show-neighbors` (mainly borrowing mcp-mikrotik in mcp-monorepo)
- `proxy` (front-end to RouterOS device)
  - Max connects, default 20
  - WebSockets to API —api-port <https://bun.com/docs/guides/http/sse>
  - CORS for REST
- All support completions for bash / zsh (Mac)

Settings:

- All settings can be CLI or ENV (or via API constructs)
- Interface merging of ENVs: <https://bun.com/docs/runtime/environment-variables#typescript> =>  <https://www.typescriptlang.org/docs/handbook/declaration-merging.html#merging-interfaces>

MCP and webproxy support with Dockerfile:

- MCP with OAuth/Passkeys supported (tied in with webproxy)
- webproxy support RADIUS/user-manager as auth source for proxying OAuth2 and/or Passkeys
- Available as MikroTik /app so Dockerfile build to start mcp/webproxy, which allow DDNS name which can be used for passkey support in web proxy
