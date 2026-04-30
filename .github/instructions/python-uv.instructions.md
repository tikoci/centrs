---
applyTo: "**/*.py,**/*.py*,package.json,README.md,.github/workflows/*.yaml,.github/workflows/*.yml"
---

# Python tooling

Shipping code and tests should be TypeScript unless a spec explicitly chooses another language.

Python is acceptable for one-off development tooling. When Python is used, prefer `uv` and `uvx`; do not add `venv`, Conda, or pip-managed project environments.
