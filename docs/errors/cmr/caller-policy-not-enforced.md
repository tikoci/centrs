# `cmr/caller-policy-not-enforced`

A warning on `execute --cmr`: the controller login lacks a policy that the
command runs with on the clients, and RouterOS does not check it. The login
does not limit what a CMR command can change.

## Typical trigger

A write through `--cmr` with a controller login whose group lacks `write`,
`test` or `reboot`, such as a "reader" account given to an agent. CMR runs
every `run-script` script on each selected client with `read`, `write`,
`test` and `reboot`, the controller's own row included. On 7.26beta1 (CHR and
real hardware) RouterOS checked only that the caller had `read` and `api`:

| Controller login | Direct write or reboot | Through CMR |
| --- | --- | --- |
| `read,api,rest-api` | `not enough permissions (9)` | `run-script` wrote to and rebooted clients |
| `read,test,api,rest-api` | `not enough permissions (9)` | `/cmr/device/reboot` rebooted a client too |

`context` names the login (`username`, `group`), the policies it lacks
(`missing`) and the ones the script ran with (`runsWith`). centrs reads the
policy once per run, from the login's own `/user` row and `/user/group`, and
only for a write. When that read fails (for example a RADIUS login with no
`/user` row) there is no warning.

## Fix

Nothing failed; this is information. Do not treat a controller login as
read-only once the `cmr` package is installed. centrs' write gate (`--yes`,
and `mcp=ro` over MCP) is the only gate that holds, so keep it on, and give an
agent a login on the controller only if it may change every paired device.
