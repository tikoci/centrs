# Initial Design Goal

This work item is the original grounding prompt for `centrs`. Stable decisions from the strawman now live in:

- `README.md` for product and CLI direction.
- `docs/ARCHITECTURE.md` for boundaries and core concepts.
- `docs/WORKFLOW.md` for agent workflow.
- `docs/specs/S001-project-structure.md` for repository layout.
- `docs/specs/S002-protocols-and-access.md` for access protocols and validation.
- `docs/specs/S003-device-discovery-and-cache.md` for device sources and cache.
- `docs/specs/S004-cli-settings-and-precedence.md` for settings alignment.

## Original intent retained

Build the missing tikoci project for practical RouterOS interaction: a Bun/TypeScript library and future CLI/TUI/MCP/webproxy that can talk to RouterOS through several protocols, know where devices and credentials come from, and help humans or agents validate RouterOS-shaped operations before they touch a router.

The key product stance remains:

- `centrs` is a friendly conduit, not a high-level RouterOS abstraction.
- Direct RouterOS syntax remains visible.
- Protocol, credential, port, discovery, and validation details should be handled consistently.
- Agent usability is a first-class product requirement.
- Runtime behavior should be grounded by real RouterOS CHR integration tests where possible.

## Open follow-up work

- Define the first implemented CLI command in a new spec or by expanding `S004`.
- Decide the native SQLite schema for device/cache storage.
- Decide the first RouterOS CHR integration test slice using `quickchr`.
- Generate API and CLI docs from code once the command models exist.
