# Source Code Rules

- Use Bun-native TypeScript and Web APIs where possible.
- Keep the TypeScript API as the root contract; CLI, MCP, TUI, and proxy surfaces should wrap shared core behavior rather than reimplementing it.
- Preserve RouterOS syntax and semantics. Do not add high-level RouterOS configuration helpers; that boundary is fixed in `docs/CONSTITUTION.md`.
- Export typed models before adding generated docs or frontend-specific wrappers.
- Errors must be actionable for humans and agents, with next-step guidance when a dependency, protocol, credential, or validation source is missing.
