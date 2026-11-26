# `settings/dotenv-ignored`

A warning, printed on stderr before the command runs: Bun loaded `CENTRS_*`
keys from a `.env` file in the working directory, so centrs re-ran itself
under `bun --no-env-file` with the environment it was started with. The
command then ran as if those keys, and anything else the file set, were
unset.

centrs reads settings from flags, the process environment, `centrs.env` and
the CDB. A repository's `.env` is none of those, and a cloned repo must not be
able to switch off TLS checks (`CENTRS_INSECURE`), pick the CDB
(`CENTRS_CDB_FILE`) or name a password file (`CENTRS_PASSWORD_FILE`). The
warning names the keys and files, never the values.

## Typical triggers

- Running `centrs`, or an agent host starting `centrs mcp`, inside a project
  whose `.env`, `.env.local` or `.env.development` sets `CENTRS_*` *(code)*.
- On macOS or Windows, a key the shell exported that a `.env` file also
  names. Only Linux can tell the two apart, so elsewhere it is dropped too
  *(code)*. Only `PATH` and the Windows system variables are kept; a dropped
  `HOME` falls back to the account's home directory.

## Fix

- Pass the key's flag for the run that needs it. On Linux, exporting the key
  in the shell works too. On macOS and Windows an export is dropped while a
  `.env` file names the key, so remove that line from the `.env` first.
- For a lasting preference, use `centrs settings set <key> <value>`, which
  writes the user-global `centrs.env`. It refuses credentials and the
  password-file keys (`CENTRS_PASSWORD_FILE`, `CENTRS_CDB_PASSWORD_FILE`);
  name a file with `--password-file` / `--cdb-password-file`, or export the
  key in the shell or container environment.
- Or remove the `CENTRS_*` lines from the project's `.env`.

## Related

- [`settings/reserved-key`](reserved-key.md)
