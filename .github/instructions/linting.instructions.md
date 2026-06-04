---
applyTo: "src/**/*.ts,src/**/*.tsx,test/**/*.test.ts,.githooks/**,cspell.json,GLOSSARY.txt,.markdownlint-cli2.yaml,.markdownlint.yaml,**/.markdownlint*.yaml,biome.json,tsconfig.json,Dockerfile,**/*.md,package.json,bun.lock"
---

# Linting and validation

Run the narrowest useful check while editing, then the full relevant gate before finishing.

- `bun run lint` is the fast source gate.
- `bun run lint:ci` includes docs, spelling, secrets, and agent instruction checks.
- Prefer concise command output so agents can inspect failures without losing context.
- Add schema-aware JSON/YAML validation when this repo starts owning non-trivial schemas.
- Update `GLOSSARY.txt` or local ignore comments for intentional project vocabulary.

## Biome ↔ tsc policy

`biome.json` is pure strict JSON (Biome lints its own config as JSON, so inline
comments are parse errors — keep the rationale here, not in the file):

- **`complexity/useLiteralKeys` is `off`.** It conflicts with tsconfig
  `noPropertyAccessFromIndexSignature`, which *requires* bracket notation for
  index-signature types (`process.env`, `Record<string, T>`, `CommonSettingsMeta`).
  Applying Biome's fix fails tsc with TS4111, so tsc is authoritative. Do not
  re-enable the rule without also dropping the tsconfig flag.
- **`.claude/settings.local.json` is excluded** via `files.includes`. It is
  harness-managed (rewritten as permissions are granted) and gitignored, so it
  never reaches CI; the explicit exclude keeps a mid-session rewrite from dirtying
  the local Biome run.
- Keep `biome.json`'s `$schema` version, the `package.json` pin, and `bun.lock` in
  lockstep; CI installs `--frozen-lockfile`, so a drifted local binary (not the
  lockfile) is the usual cause of a `deserialize` schema-mismatch info.
