---
applyTo: "src/**/*.ts,src/**/*.tsx,test/**/*.test.ts,.githooks/**,cspell.json,.cspell.words.txt,.markdownlint-cli2.yaml,.markdownlint.yaml,**/.markdownlint*.yaml,biome.json,tsconfig.json,Dockerfile,**/*.md,package.json,bun.lock"
---

# Linting and validation

Run the narrowest useful check while editing, then the full relevant gate before finishing.

- `bun run lint` is the fast source gate.
- `bun run lint:ci` includes docs, spelling, secrets, and agent instruction checks.
- Prefer concise command output so agents can inspect failures without losing context.
- Add schema-aware JSON/YAML validation when this repo starts owning non-trivial schemas.
- Update `.cspell.words.txt` or local ignore comments for intentional project vocabulary.
