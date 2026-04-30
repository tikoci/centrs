---
paths:
  - "**/*.py"
  - "**/*.py*"
  - "package.json"
  - "README.md"
  - ".github/workflows/*.yaml"
  - ".github/workflows/*.yml"
---

> TODO: Python okay for dev tools and one-off tasks, but all shipping code or tests should use TypeScript.  Any python code should never use venv (virtual environments), conda, etc. => use `python`/`python3` or `uv`/`uvx` instead.
