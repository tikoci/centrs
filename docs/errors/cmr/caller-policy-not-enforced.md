# `cmr/caller-policy-not-enforced`

A warning on `execute --cmr`: the controller login lacks a policy that the
command runs with on the clients, and RouterOS does not check it. The login
does not limit what a CMR command can change.

## Typical trigger

A write through `--cmr` with a controller login whose group lacks `write`,
`test` or `reboot`, such as a "reader" account given to an agent. CMR runs
every `run-script` script on each selected client with `read`, `write`,
`test` and `reboot`, the controller's own row included. On 7.26beta1,
RouterOS checked only that the caller had `read` and `api`. These results
come from the CHR reproduction on #456 (REST, two-CHR lab, 2026-10-13); the
same `run-script` write was seen on real hardware, and the integration test
re-proves it (CMR15 in `commands/execute/examples.md`):

| Controller login | Direct write or reboot | Through CMR |
| --- | --- | --- |
| `read,api,rest-api` | `not enough permissions (9)` | `run-script` wrote to a client and rebooted it |
| `read,test,api,rest-api` | `not enough permissions (9)` | `run-script` wrote to the controller's own row; `/cmr/device/reboot` rebooted a client |

MikroTik [says](https://forum.mikrotik.com/t/7-26beta-development-is-released/273582/139) this is fixed for 7.26beta2: a `read` group will not
be allowed to do it. That has not been checked on a beta2 build yet. centrs
still warns on any version, because the warning reads the login's policy, not
the RouterOS version. On a build that refuses the write, the members fail
instead and the warning only says what the login lacks.

`context` names the login (`username`, `group`), the policies it lacks
(`missing`) and the ones the script ran with (`runsWith`). centrs reads the
policy once per run, from the login's own `/user` row and `/user/group`, and
only for a write. When that read fails (for example a RADIUS login with no
`/user` row) there is no warning.

## Fix

Nothing failed; this is information. Do not treat a controller login as
read-only once the `cmr` package is installed (on 7.26beta1 at least). The
gates that hold are centrs' own: pass `--yes` only when you intend the write
on every selected client, and over MCP keep the controller's record at
`mcp=ro` (the default), which refuses CMR fleet commands outright. Give an
agent a login on the controller only if it may change every paired device.
