# Plan: schema IR protocol knowledge spike

## Approach

Start with a small, reviewable proof point. Use CDB/Nova field knowledge only if
the CDB spike first identifies a safe grounded slice.

## Workstreams

1. Requirements
   - List what schema IR would need to express: fields, binary representation,
     semantics, constraints, provenance, redaction, and lossy projections.
   - Identify what TypeScript types, tests, markdown specs, and generated docs
     already cover well enough.

2. Prototype boundary
   - Choose one small CDB or Nova structure.
   - Express it as plain data.
   - Derive a validator, documentation projection, and diff.

3. Decision
   - Adopt for a small protocol-knowledge layer, defer until more formats exist,
     or reject as unnecessary machinery.
   - If adopted, define where generated output lives and which file is hand-edited
     source of truth.
