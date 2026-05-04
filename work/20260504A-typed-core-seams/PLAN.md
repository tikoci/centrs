# Plan: typed core seams

1. Capture the current implementation inventory so the next specs talk about the
   code that exists, not the platform that is merely planned.
2. Stage the missing shared contracts:
   - structured errors and bug reports,
   - transport adapter seam,
   - typed target model and resolver,
   - settings resolver with source reporting.
3. Make developer UX explicit in the alpha-direction docs so help output,
   diagnostics, and future generated docs are treated as shared-core behavior.
4. Promote only the stable parts into specs; keep the still-moving interface
   details here until the first transport and CLI loop are grounded.
