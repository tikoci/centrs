# `cmr/validation-incomplete`

The validation result from a CMR client was incomplete, so the command was
**not** sent to it. The other members are unaffected.

## Typical trigger

centrs validates on each client with `:put [:parse <command>]; :put "<nonce>"`
through `run-script`. The result is rejected before it is classified when:

- the status was not `success` (for example `timed out (6)`);
- the output was clipped by CMR's ~60 KiB cap (`...(+N B)`);
- the nonce line that proves the output is complete is missing;
- the `:parse` return was empty or was not parse output (IL).

An empty or clipped result is not a pass. Without the completeness check,
missing output would have read as "no diagnostic".

## Fix

- Make sure the client is connected and responsive, then retry.
- Very large commands can exceed the output cap once `:parse` echoes them back.
  Split the work into smaller commands.
