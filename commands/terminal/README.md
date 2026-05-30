# terminal

Open an interactive RouterOS console.

Status: `not-started`. This file is a stub.

## Intent

- `ssh` is the default. Honors system `ssh` config; `--ssh-key` overrides.
  CDB metadata may carry the path to a per-router private key.
- `mac-telnet` is the right transport when `<router>` is a MAC address, or
  when SSH is unreachable but a MAC is on file (Layer-2 emergency access).
- REST and native API have no terminal capability; `--via rest-api` for
  `terminal` must error with `transport/capability-unsupported`.
- RoMON and WinBox Terminal are execute protocol surfaces in centrs, not
  terminal routes, unless future matrix cells explicitly add terminal support.

## Open questions

- How to surface keystroke recording / replay for tests.

Defer until at least one transport beyond REST is implemented.
