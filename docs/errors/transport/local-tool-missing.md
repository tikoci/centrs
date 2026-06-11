# `transport/local-tool-missing`

A required local CLI (e.g. the OpenSSH `sftp` client) is not installed or not on
PATH.

## Fix

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) for the centrs error
contract. The SFTP transfer path shells out to the host OpenSSH `sftp` client;
install an OpenSSH client (macOS ships it; Debian/Ubuntu: `openssh-client`) so
`sftp` is on PATH, or use `--via rest` / `--via native` for files ≤60 KB.
