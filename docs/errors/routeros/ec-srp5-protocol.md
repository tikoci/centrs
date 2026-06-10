# `routeros/ec-srp5-protocol`

An EC-SRP5 authentication message or key could not be processed.

## Fix

The peer sent a malformed EC-SRP5 public key, an out-of-range value, or the
shared-secret computation degenerated (the point at infinity). This is the shared
EC-SRP5 layer used by both MAC-Telnet (MTWEI) and the bandwidth test (btest);
confirm the remote end is a genuine MikroTik device and retry. See
[`docs/CONSTITUTION.md`](../../CONSTITUTION.md) for the centrs error contract.
