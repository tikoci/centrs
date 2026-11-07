# components/

Each `components/<name>/` holds the spec for one part of centrs that spans
commands: a transport, a target source, an analysis layer. It is the
`commands/` scheme for things that are not a verb.

- Make one when a contract would otherwise grow a command README with content
  other commands need (offline analysis did this to `commands/explain/`), or
  when a concept has no owning command (CMR). No placeholder entries: a
  component directory starts with real content about code that exists.
- `README.md` opens with the `src/` files it covers and the commands or
  surfaces that use it. It owns what centrs promises callers across commands.
  Command-specific flags and behavior stay in the command README, which links
  here.
- Wire-format, auth, and delivery facts stay in the `src/protocols/*.ts`
  module headers. A transport's README links to its header and does not
  restate it.
- `examples.md` is only for a component with a library surface. Its examples
  are real TypeScript against the public exports (`@tikoci/centrs`,
  `@tikoci/centrs/explain`), never pseudo-code, numbered and mapped to named
  tests like command examples. The first component `examples.md` lands with a
  check that type-checks its code blocks.
- `docs/MATRIX.md` → Components is the only status surface; a README's
  "Status" line must agree with it. Direction that is not built is a parked
  theme in the matrix, not a section here.

Do not restate the constitution here or in a component README; link to
`docs/CONSTITUTION.md`.
