---
applyTo: "README.md,src/cli.ts,src/index.ts,commands/**"
---

# README as CLI manual

`README.md` is the user-facing CLI overview; the flag reference is generated.

- Per-command behavior lives in `commands/<name>/README.md` and is exercised
  by `commands/<name>/examples.md`. README links to those, not specs.
- Implemented flags are documented only in the generated `docs/CLI.md`
  (`bun run docs:cli`, drift-gated in CI); flag changes edit the
  `CliCommandMetadata` in `src/cli/*.ts` and regenerate — never a hand-edited
  flag table.
- Any change to command names, flags, environment variables, defaults, or
  examples must update the per-command README and `examples.md` in the same
  change as the source.
- Keep root README concise. Cross-cutting rules go in `docs/CONSTITUTION.md`.
