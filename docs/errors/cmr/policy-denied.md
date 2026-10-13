# `cmr/policy-denied`

A CMR client ran the command and refused it with `not enough permissions (9)`.

CMR runs `run-script` scripts on each client with only the `read`, `write`,
`test` and `reboot` policies, and without a user session. Validation cannot
catch this: the client's `:parse` accepts the command, and the policy check
happens only when it runs. Nothing was changed on that client.

## Typical trigger

- `/user add`, `/user group add` (needs `policy`).
- `/tool sniffer` (needs `sniff`).
- Reading a sensitive value returns `*` or an empty value rather than failing.

## Fix

Run the command on the device directly, with a user that has the policy:

```sh
centrs execute <device> -- '<command>'
```
