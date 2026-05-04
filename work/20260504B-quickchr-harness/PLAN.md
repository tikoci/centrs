# Plan: quickchr harness

1. Turn the current skipped integration placeholder into an explicit harness
   design target instead of an orphan file.
2. Define which tests stay in default unit runs and which move to explicit fast
   and deep CHR-backed tiers.
3. Centralize version selection so long-term, stable, and beta coverage can be
   updated without rewriting each test.
4. Make the shared error-contract checks part of harness design before the first
   transport lands.
