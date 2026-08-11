---
applyTo: ".github/workflows/*.yml,.github/workflows/*.yaml,package.json,.githooks/**"
---

# Git hooks and CI gates

Keep local hooks and CI aligned with `package.json` scripts.

- Pre-commit runs `lint:git:commit` (Biome). Keep it deterministic and close to
  instant so it catches formatting and source-lint mistakes without interrupting
  normal commit iteration.
- Pre-push runs `lint:git:push`, which is exactly `lint:ci`: source/type checks,
  generated-doc drift, Markdown, spelling, and secrets. Keep its normal wall
  time near 30 seconds on a development machine.
- Unit tests and the build are required, separate jobs in `ci.yaml`; do not
  duplicate them in pre-push. `bun run ci` remains the sequential local aggregate
  when a contributor wants all three non-CHR gates before pushing.
- Do not add hook-only behavior that CI cannot reproduce.
