# `cmr/policy-denied`

A CMR client ran the command and refused one of its statements with
`not enough permissions (9)`.

CMR runs `run-script` scripts on each client with only the `read`, `write`,
`test` and `reboot` policies, and without a user session. Validation cannot
catch this: the client's `:parse` accepts the command, and the policy check
happens only when it runs.

The refused statement did not run, and the script stopped there. Statements
before it **did** run: CMR does not roll them back. Their output, followed by
the diagnostic, is in `context.output`.

## Typical trigger

- `/user add`, `/user group add` (needs `policy`).
- `/tool sniffer` (needs `sniff`).

Reading a sensitive value is not this error: it succeeds and returns `*` or an
empty value.

## Fix

Check what the earlier statements changed. Then run only the refused
statement, and the ones after it, on the device directly with a user that has
the policy:

```sh
centrs execute <device> -- '<command>'
```
