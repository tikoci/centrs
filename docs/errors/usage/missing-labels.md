# `usage/missing-labels`

`centrs execute --cmr` was given no `--labels` expression.

## Typical trigger

`--cmr` runs the command on the CMR clients a label expression selects, and the
expression is required so the blast radius is always explicit.

## Fix

Pass RouterOS label syntax: a comma list where plain labels are OR, `+label`
must match, `-label` excludes, and `all` selects every device, including the
controller:

```sh
centrs execute ctl --cmr --labels all -- ':put [/system/identity/get name]'
centrs execute ctl --cmr --labels site-a,+edge,-ctl --yes -- '/ip/dns/set servers=192.0.2.53'
```
