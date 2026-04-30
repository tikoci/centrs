# Protocol Rules

Follow `docs/specs/S002-protocols-and-access.md`.

- Model protocols by capabilities, not by frontend.
- Keep validation and execution separate so callers can explain, validate, and run in distinct phases.
- Do not silently fall back to another protocol when the user requested `via`.
- Surface missing local tools with platform-aware install or remediation advice.
