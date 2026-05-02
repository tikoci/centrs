# Goal: schema IR protocol knowledge spike

## Problem

Binary and semi-structured RouterOS-adjacent formats such as CDB, Nova messages,
Dude DB payloads, and protocol capability maps can become difficult to review if
the only source of truth is handwritten TypeScript. The review proposed a
plain-data schema IR so validation, projection, and diffs can be derived from an
auditable structure.

## Scope

- Evaluate whether a plain-data schema IR helps with CDB/Nova/Dude/protocol
  knowledge.
- Separate shape, semantics, representation, validation, projection, and
  loss-aware transforms.
- Test the idea against a small grounded slice before changing production code.
- Decide adopt, defer, or reject.

## Non-goals

- Add a schema framework dependency.
- Replace accepted specs with generated schema artifacts.
- Build a broad DSL before proving one small RouterOS data slice.

## Source material

- `work/20260430B-protocol-data-grounding/review-triage.md`
- `work/20260502A-winbox-cdb-device-store/`
- `docs/WORKFLOW.md`
- `docs/ARCHITECTURE.md`
