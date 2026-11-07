# cmr

Status: `CHR-passed` on 7.26beta1, through the `execute` rest-api and
native-api cells; its examples are CMR0–CMR18 in
[`commands/execute/examples.md`](../../commands/execute/examples.md#cmr-clients-through-a-controller-450).
Later betas are not covered yet (see [Builds](#builds)). Matches
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
| 7.26beta3 | A restricted login's `run-script` is refused: `not enough permissions (9)` over native-api, a dropped connection over REST. An admin `run-script numbers=<client>` returned `no devices selected` (#527). |
| 7.26beta5 | The lab fails at CMR-D1. The client is paired and connected on both sides (`/cmr/client` status `paired,connected`; the controller's row has `state="pair: device:ok, cmr:ok"`). With `pairing-requirement=none` it paired itself about a second after it was enabled, before the lab's `pair` command. Yet an admin `run-script` selects only the controller: `labels=all` returns the controller's rows alone, and `labels=<client identity>` or `numbers=<client .id>` is `no devices selected`, over REST and the console (2026-11-07; details on #527). |

The lab boots `CMR_SINCE` (7.26beta1). `CENTRS_CMR_VERSION` boots another
build. The lab should follow the development channel, so a beta that changes
CMR turns the suite red. That switch waits until the suite passes on the
current beta (#527), because a red nightly blocks merges.

For each build checked, add a row above. rosetta's changelog search
(`category: cmr`) and a `/cmr` command diff between builds show what a beta
changed.
