# Status: RouterOS layer-2 lab grounding

## Current state

- Work item created from the May 1 protocol/data grounding review.
- Existing 20260430B notes are enough for target-model planning, but not for
  implementation.
- No lab topology has been accepted.

## Open questions

- Can `quickchr` provide the needed shared L2 behavior on macOS and Linux CI?
- Which tests need elevated privileges or real interfaces?
- What should be the opt-in command for lab tests?
- How should a target carry both IP and MAC identities while preserving source
  provenance?

## Deferred

- MAC Telnet and RoMON adapters remain deferred.
- MNDP persistence remains deferred until the target/cache model is typed.
