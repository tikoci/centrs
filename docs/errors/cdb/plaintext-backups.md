# `cdb/plaintext-backups`

CDB backups may still contain plaintext credentials after encryption.

## Fix

Apply your own secure backup and retention policy to the `.bak.*` files beside
the CDB. `devices encrypt` protects only the active CDB and retains every backup,
including the plaintext snapshot created during conversion. It does not encrypt
or delete old copies. This warning also accompanies already-encrypted no-op runs,
since prior backup protection cannot be inferred from the active file.
