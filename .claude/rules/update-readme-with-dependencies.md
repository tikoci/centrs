---
description: Document external dependencies when package or workflow requirements change.
paths:
  - "package.json"
  - "bun.lock"
  - ".github/workflows/*"
  - "README.md"
---

When adding runtime or development dependencies, update README if users need to install an external tool outside `bun install`.

Include platform notes for macOS, Linux, and Windows when a dependency is OS-specific.
