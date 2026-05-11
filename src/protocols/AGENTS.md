# Protocol Rules

Follow `docs/CONSTITUTION.md` (protocol selection section) and the
appropriate `commands/<name>/README.md`.

- Model protocols by capabilities, not by frontend.
- Ground protocol facts before implementation: RouterOS service/API/CLI path,
  auth model, default port, local tooling, validation source, security warnings,
  failure modes, and CHR test shape.
- Prefer rosetta MCP lookups and related tikoci project evidence over general
  web search for RouterOS-specific facts.
- Keep validation and execution separate so callers can explain, validate, and run in distinct phases.
- Do not silently fall back to another protocol when the user requested `via`.
- Surface missing local tools with platform-aware install or remediation advice.
