---
description: Keep temporary agent artifacts isolated from shipping code.
paths:
  - ".scratch/**"
---
Use `.scratch/` for temporary code, generated experiments, and local artifacts that should not be committed.

Do not reference `.scratch/` content from shipping code or committed docs unless that content has been promoted into `work/`, `docs/`, `src/`, or `test/`.
