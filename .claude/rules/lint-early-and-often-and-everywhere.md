---
paths:
  - "src/**/*.{ts,tsx}"
  - "test/**/*.test.ts"
  - ".githooks/**"
  - ".git/hooks"
  - "cspell.json"
  - ".cspell.words.txt"
  - ".markdownlint-cli2.yaml"
  - ".markdownlint.yaml"
  - "**/.markdownlint*.yaml"
  - "biome.json"
  - "tsconfig.json"
  - "Dockerfile"
  - "**/*.md"
  - "*.md"
---

> TODO: treat all tools as suggest/concept to check but should cover using "gold standard" tools for linting **all files**.  If a linter exists, we want to run it.  We may not want **fail** in all cases, but data should be in CI outputs/reporting.  Linting should be friendly to agents, so `head` | `tail` operations are "messed up" by overwhelming linting output, so that a consideration.  Some package.json (that may not be right half)
>
> - TBD json and yaml lint (check call YAML for syntax, including but not exclusively ./github/workflows/*)
> - TBD zod ajv or similar to JSON/YAML schemas [include github actions using schema form schemastore, any json file we create should have a schema associated with it](https://github.com/ajv-validator/ajv) and [https://github.com/SchemaStore/schemastore/blob/master/src/schemas/json/github-action.json]
> - skillcheck (verify project SKILL.md are valid, use uvx)
> - biome for all it covers
> - markdownlint-cli2 for all markdown (different rules for agent files and user-visible files)
> - cSpell for spelling, uses .cspell.words.txt as custom dictionary => update words or use cSpell comments as needed to keep spelling errors 0 before commit/push

> TODO: link .githooks to .git/hooks in some appropriate scheme, so hooks are pre-repo

> SEE package.json scripts with _some_ initial examples, more for guidance/preference that fully baked or firm commitments to any tool - use best judgement

> TODO: include dependencies for linux/mac/windows in README.md
