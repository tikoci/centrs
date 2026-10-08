# `input/local-destination`

A local download destination cannot be written (missing parent directory, a directory, or no permission).

`transfer download` checks the local destination before it reads anything
from the device. The parent directory must already exist, because centrs does
not create directories, and the destination itself must not be a directory.
A path that cannot be checked at all (no permission on a directory along the
way, a file used as a directory, a symlink loop) fails the same way. A write
that still fails afterwards (no permission, the directory removed
mid-transfer) reports this code too, with the operating-system error as the
cause.

## Fix

- Create the parent directory first: `mkdir -p DIR`, then retry the download.
- Name a file, not a directory: `download fw.rsc ./backups/fw.rsc`, not
  `download fw.rsc ./backups/`.
- Pass `-` as the local path to write the bytes to stdout instead.
- For a fan-out download, `--out-dir` must be an existing directory.
