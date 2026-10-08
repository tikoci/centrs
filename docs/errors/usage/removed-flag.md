# `usage/removed-flag`

A flag or request field was removed; the error names its replacement.

## Fix

Run the replacement printed in the error's remediation.

`api --listen` (and the library's `ApiRequest.listen`) is the current case
(#402). It meant "stream the replies" and also turned a GET of a menu into a
change subscription. `api` now sends the command as typed:

- To follow changes, request the menu's `listen`:
  `centrs api <router> ip/address/listen`. A `/listen` endpoint implies
  `--stream` and native-api.
- To stream any other command's replies, use `--stream`
  (`ApiRequest.stream` / `apiStream()` in the library).

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) for the centrs error
contract.
