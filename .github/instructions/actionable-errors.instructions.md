---
applyTo: "src/**,docs/CONSTITUTION.md,commands/**"
---

# Actionable errors

Error messages are part of the public API.

- Explain what failed, why it matters, and the next action the caller can take.
- Include RouterOS path, protocol, device source, and validation source when those details explain the failure.
- When a local tool is required, check for it where practical and suggest a platform-aware install or workaround.
- Do not hide internal error details; attach them as structured cause/debug data instead of making the main message unreadable.
