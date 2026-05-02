---
applyTo: ".scratch/**"
---

# Scratch directory

Use `.scratch/` as the repo-local middle ground between `/tmp` and durable project paths: temporary code, generated experiments, one-off notes, and local artifacts that should not be committed.

Do not reference `.scratch/` content from shipping code or committed docs unless that content has been promoted into `work/`, `docs/`, `src/`, or `test/`.
