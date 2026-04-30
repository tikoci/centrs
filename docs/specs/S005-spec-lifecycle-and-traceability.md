# S005: Spec Lifecycle and Traceability

## Status

Accepted.

Metadata:

- Supersedes: none
- Superseded by: none
- Scope: extends S001
- Review source: follow-up structure hardening

## Context

File-based specs are easy to create and hard to retire. Without lifecycle rules, agents can accidentally treat historical decisions, deltas, and current requirements as equally authoritative.

## Requirements

- Every spec must declare status, supersession, scope, and review source near the top.
- `Accepted` specs are normative. `Draft`, `Superseded`, and `Obsolete` specs are not normative unless another accepted spec explicitly incorporates part of them.
- Prefer replacement specs that restate the current effective behavior over long chains of delta-only specs.
- When a spec is superseded, update the old and new specs in the same change.
- Code, tests, README sections, and generated-doc sources should cite the governing spec ID when behavior is non-obvious or likely to be revisited.

## Status values

| Status | Meaning |
| --- | --- |
| `Draft` | Proposed direction. Useful for review, not yet a contract. |
| `Accepted` | Current source of truth for its scope. |
| `Superseded` | Historical; replaced by another spec. |
| `Obsolete` | Historical; intentionally abandoned. |

## Scope values

| Scope | Use |
| --- | --- |
| `baseline` | Establishes a new area. |
| `extends S###` | Adds a narrower rule while the parent remains valid. |
| `replaces S###` | Replaces the parent for the stated scope. |

## Review rule

Reviewers should be able to understand the current behavior by reading the latest accepted spec for that area without reconstructing a long history. Work items and superseded specs explain why the decision changed; accepted specs explain what to build now.
