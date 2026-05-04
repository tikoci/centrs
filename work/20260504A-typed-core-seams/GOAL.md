# Goal: typed core seams

## Problem

`centrs` currently has one grounded data codec and otherwise mostly planned
frontends and transport metadata. If transport or CLI work expands before the
shared seams are typed, each adapter will likely redefine errors, target shape,
settings shape, and diagnostics in slightly different ways.

This work item stages the pre-transport seams needed to keep the first real
implementation narrow, reviewable, and easy to extend.

## Scope

- Inventory the current implemented-versus-planned reality.
- Stage the shared transport contract, target model, and settings resolver work.
- Stage the structured error and bug-report contract.
- Make developer UX explicit as a co-equal design constraint with transport
  correctness and test confidence.
- Feed stable outcomes into `S006`, `S007`, `S008`, `README.md`, and
  `docs/ARCHITECTURE.md`.

## Non-goals

- Implement a RouterOS transport.
- Finalize every CLI command or flag.
- Commit to a parser framework before the alpha command surface stabilizes.

## Source material

- External review inventory captured on 2026-05-04.
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/specs/S003-device-discovery-and-cache.md`
- `docs/specs/S004-cli-settings-and-precedence.md`
- `docs/specs/S006-alpha-first-command.md`
- `src/index.ts`
- `src/cli.ts`
- `src/protocols/index.ts`
- `test/integration/rest-retrieve.test.ts`
