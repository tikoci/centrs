# Plan: WinBox CDB device store grounding

## Approach

Use safe fixtures and reference implementations to decide what `centrs` can
promise about CDB before changing source or accepted specs.

## Workstreams

1. Fixture inventory
   - List each CDB fixture, how it was created, whether it is open or encrypted,
     and which fields it exercises.
   - Confirm `min.cdb` and empty-file behavior.

2. Schema and keying
   - Verify whether `address + user` is the effective update key.
   - Record group, workspace, RoMON agent, comments/notes, MAC-address targets,
     and saved-password behavior.
   - Test field limits, especially comments/notes if they may hold `key=value`
     metadata.

3. Password and encryption policy
   - Separate RouterOS login passwords from CDB file passwords.
   - Evaluate `CENTRS_PASSWORD`, `CENTRS_CDB_FILE`, `CENTRS_CDB_PASSWORD`, and
     `CENTRS_CDB_MODE` as candidate vocabulary.
   - Decide how open CDB, encrypted CDB, explicit password, and
     require-encryption modes should behave.

4. Provider and persistence model
   - Decide whether CDB is canonical storage, an import/export target, or one
     provider feeding SQLite.
   - Preserve S003 provenance and S004 precedence.
   - Define how imported credentials are reported without exposing or silently
     persisting them.

5. Promotion
   - Update S003/S004 only after fixture-backed behavior is stable.
   - Create implementation work only after the safe fixture and redaction test
     shape is clear.
