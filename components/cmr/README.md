# cmr

Status: `CHR-passed` on 7.26beta1, through the `execute` rest-api and
native-api cells; its examples are CMR0–CMR18 in
[`commands/execute/examples.md`](../../commands/execute/examples.md#cmr-clients-through-a-controller-450).
Later betas pass the same suite with their version splits (see
[Builds](#builds)). Matches
`docs/MATRIX.md` → Components.

Code:

- `src/core/cmr.ts`: facts shared by every surface that can reach
  `/cmr/device/run-script`, including the console-only dashboard refusal.
- `src/core/cmr-fleet.ts`: which devices a fleet command reaches, for the
  write gate.
- `src/execute-cmr.ts`: `execute --cmr`.
- Error pages: `docs/errors/cmr/`.
- Tests: `test/integration/execute-cmr.test.ts` on the two-CHR lab in
  `test/integration/cmr-lab.ts`; CMR0 (a router without CMR) in
  `test/integration/execute.test.ts`.

CMR is a selection source, not a protocol. The rules for that (controller
credentials only, binding by row id, validation on each client, never retried,
not on MCP) are in
[`docs/CONSTITUTION.md` → CMR](../../docs/CONSTITUTION.md#controller-mediated-selection-cmr).

## Where CMR shows up

| Surface | What it does | Contract |
| ------- | ------------ | -------- |
| `execute --cmr` | Runs one command on the clients a label expression selects, through the controller. | [`commands/execute/README.md` → CMR](../../commands/execute/README.md#cmr-clients-through-their-controller---cmr) |
| plain `execute`, `api` | Treat the controller's fleet commands as writes and name their reach at the `--yes` gate. A hand-written `run-script` carries `cmr/client-script-not-validated`. | [`commands/execute/README.md` → Fleet commands](../../commands/execute/README.md#fleet-commands-run-directly-453), `commands/api/README.md` |
| `retrieve`, `api` reads | The controller's own `/cmr/*` menus are ordinary reads. | — |
| `mcp` | No CMR mode. A fleet command is a write whatever the login's RouterOS policy. | `commands/mcp/README.md` |
| `explain` | Knows the `/cmr` paths offline. | `commands/explain/README.md` |

Where CMR goes next is in `docs/MATRIX.md` → CMR across surfaces, Devices and
onboarding, and Provisioning.

## Builds

CMR first shipped in 7.26beta1 and so far exists only in development builds.
The controller also needs the optional `cmr` package. A router without
`/cmr/device` is `routeros/version-unsupported` (`capability: cmr-controller`)
before 7.26beta1 and `cmr/not-a-controller` after.

| Build | What is known |
| ----- | ------------- |
| 7.26beta1 | Lab baseline: CMR1–CMR7 and CMR10–CMR18 pass over rest-api and native-api, CMR8–CMR9 over native-api. A login without `write` or `reboot` still writes through `run-script` (#456, CMR15). |
| 7.26beta3 | The credentialed `pair` can stop half-way: the client is `paired,connected`, but the controller's row keeps `state="pair: device:ok, cmr:ok"` and `run-script` never selects it. A bare `/cmr/device/pair` finishes it; the lab does that (#527). A login without both `write` and `reboot` is refused by `run-script` (`not enough permissions (9)`), so CMR15 and CMR18 are refusals. Not booted: 7.26beta2. |
| 7.26beta4 | Inside a CMR script, `local-id` is no longer masked (CMR-D7) and a client-side `/user/add` runs (CMR11, CMR11b). `/cmr/vlan/add` requires `port-labels` (CMR17). |
| 7.26beta5 | Same as 7.26beta4. |

Each split is a constant in `test/integration/chr.ts` (`CMR_*_SINCE`), and
`execute-cmr.test.ts` asserts the side the running build is on. The suite
passes on 7.26beta1, 7.26beta3, 7.26beta4 and 7.26beta5 (2026-11-11).

The lab boots `CMR_SINCE` (7.26beta1). `CENTRS_CMR_VERSION` boots another
build. The lab should follow the development channel, so a beta that changes
CMR turns the suite red; that switch is the maintainer's call (#527).

For each build checked, add a row above. rosetta's changelog search
(`category: cmr`) and a `/cmr` command diff between builds show what a beta
changed.
