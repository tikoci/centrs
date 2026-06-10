# `routeros/btest-protocol`

A bandwidth-test (btest) packet could not be decoded.

## Fix

The peer sent a malformed or unexpected btest control/data packet (a bad command
packet, EC-SRP5 auth frame, status message, or UDP datagram). Confirm the remote
end is a MikroTik `/tool/bandwidth-server` (or a btest client) on the expected
port, and that nothing else is answering on TCP/UDP 2000. See
[`docs/CONSTITUTION.md`](../../CONSTITUTION.md) for the centrs error contract and
`commands/btest/README.md` for the protocol.
