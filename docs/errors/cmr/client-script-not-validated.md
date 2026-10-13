# `cmr/client-script-not-validated`

A warning: a caller-addressed `/cmr/device/run-script`, sent through `api` or
plain `execute`, passed validation **as a controller request**. The `script=`
it carries was not validated on any CMR client.

## Typical trigger

```sh
centrs api ctl /cmr/device/run-script -X POST -f labels=all -f 'script=…' --yes
centrs execute ctl --yes -- '/cmr/device/run-script labels=all script="…"'
```

`/console/inspect` on the controller checks `labels=` and `script=` as
arguments. To the controller's `:parse`, the script is an opaque string, so a
`passed` gate says nothing about whether each client accepts it.

## Fix

Use `centrs execute <controller> --cmr --labels <expr> -- '<command>'`. It runs
`:parse` on every selected client through CMR and sends the command only to the
clients that accepted it.
