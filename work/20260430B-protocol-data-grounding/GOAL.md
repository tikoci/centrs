# Goal: protocol/data grounding before implementation

## Problem

`centrs` needs a strong evidence trail before protocol adapters, discovery
paths, data imports, proxy/eventing surfaces, or CLI behavior become source
code. The project already names REST, native API, SSH, SNMP, MNDP, MAC Telnet,
RoMON, WinBox Terminal, WinBox CDB, Dude DB, and SQLite cache as planned
surfaces, but many of those areas have known dark holes.

The goal of this work item is to collect and organize protocol/data facts so
future specs and implementations can cite work evidence instead of rediscovering
RouterOS behavior while hacking core code.

## Scope

- Build protocol and data-source matrices with source references.
- Identify which facts are grounded enough for specs and which remain research
  risks.
- Align agentic workflow: when to use `work/`, scoped instructions, user-level
  skills, and possible future custom agents.
- Keep source implementation out of scope until the relevant work is grounded.

## Non-goals

- Implement a protocol adapter.
- Implement WinBox CDB, Dude DB, MNDP cache, or credential storage.
- Accept S006 or create feature specs before the matrices are ready.
- Duplicate user-level RouterOS skills inside this repo.

## Source material

- Root project docs: `README.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`,
  `docs/specs/S002-protocols-and-access.md`,
  `docs/specs/S003-device-discovery-and-cache.md`, and
  `docs/specs/S006-alpha-first-command.md`.
- Existing instructions: `AGENTS.md`, `src/protocols/AGENTS.md`,
  `src/data/AGENTS.md`, `test/AGENTS.md`, and
  `.github/instructions/routeros-grounding.instructions.md`.
- User-level skills: `tikoci-crossref`, `routeros-fundamentals`,
  `routeros-qemu-chr`, `routeros-mndp`, and related RouterOS skills.
- Related projects and references listed in `references.md`.

## Working assumptions

- `work/` is the go-to location for moderate RouterOS protocol/data research.
- Specs should cite work evidence for non-obvious behavior.
- Repo-level `SKILL.md` and custom agents are deferred until repeated grounding
  work proves they add more value than scoped instructions plus user-level
  skills.
- REST remains the likely first alpha transport, but native API eventing, MAC
  Telnet emergency access, and data imports must be understood early enough that
  shared settings and target models do not paint the project into a corner.
