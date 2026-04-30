---
description: Keep README aligned with user-facing CLI behavior.
paths:
  - "README.md"
  - "src/cli.ts"
  - "src/index.ts"
  - "docs/specs/S004-cli-settings-and-precedence.md"
---

`README.md` is the user-facing CLI manual until generated CLI docs exist.

- Any change to command names, flags, environment variables, defaults, or examples must update README or the generated-doc source in the same change.
- Keep README concise and link deeper behavior to `docs/specs/`.
