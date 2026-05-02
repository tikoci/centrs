# Status: WinBox CDB device store grounding

## Current state

- Work item created from the May 1 protocol/data grounding review.
- No CDB parser, writer, importer, or accepted settings changes have been made.
- Existing safe fixture names suggest coverage for empty/minimal files,
  saved-password and no-saved-password rows, MAC-address targets, groups,
  comments, RoMON-related entries, and encrypted examples.

## Working hypotheses

- CDB is a strong candidate for the first-class `centrs devices` data target.
- `address + user` appears to be the entry identity; group is an attribute.
- Comments/notes may carry RouterOS-style `key=value` metadata for non-default
  protocol ports or other per-device hints.
- CDB file passwords and RouterOS login passwords must be modeled separately even
  when a user chooses the same value for both.

## Deferred or rejected

- Direct implementation is deferred until fixture and compatibility evidence is
  reviewable.
- Automatic secret persistence is rejected.
- Automatic CDB encryption using an unrelated RouterOS password is rejected.
- Extending CDB records with new fields is rejected unless compatibility testing
  proves it safe.
