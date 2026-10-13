# `cmr/not-a-controller`

`execute --cmr` was pointed at a router that does not answer `/cmr/device`, so
it is not a CMR controller.

## Typical trigger

- The target runs RouterOS older than 7.26beta1, where CMR does not exist.
- The optional `cmr` package is not installed. Clients only have the built-in
  `/cmr/client`; the controller needs the package.
- The target is a CMR *client*, not its controller.

Only a missing menu raises this: native API reports `no such command prefix`,
REST `no such command or directory (cmr)`. Any other failure reading
`/cmr/device`, such as a permissions error, is reported unchanged.

## Fix

Point the command at the controller: the router with the `cmr` package and
`/cmr set enabled=yes`. Its `/cmr/device print` lists the clients `--labels`
selects from.
