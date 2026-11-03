# `cdb/encrypt-failed`

The existing CDB could not be rewritten with encryption.

## Fix

Check directory permissions and available disk space, then retry
`centrs devices encrypt`. Preserve the original file and any timestamped backups
before recovery. A failed write may already have created a plaintext backup;
encryption does not protect that backup.
