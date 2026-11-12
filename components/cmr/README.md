# cmr

Status: `CHR-passed` on 7.26beta5, through the `execute` rest-api and
native-api cells; its examples are CMR0–CMR18 in
[`commands/execute/examples.md`](../../commands/execute/examples.md#cmr-clients-through-a-controller-450).
Historical builds pass the same suite with their version splits (see
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

RouterOS's own CMR behaviour per build (pairing states and sequences,
`run-script` policy, export, alerts, upgrade rules) is grounded in quickchr's
CMR lab:
[`examples/cmr/FINDINGS.md`](https://github.com/tikoci/quickchr/blob/main/examples/cmr/FINDINGS.md).
Cite that file for a RouterOS claim, and add new CMR research there as a quickchr
study. This README keeps only what centrs asserts: the contracts below and their
version splits.

CMR first shipped in 7.26beta1 and so far exists only in development builds.
The controller also needs the optional `cmr` package. A router without
`/cmr/device` is `routeros/version-unsupported` (`capability: cmr-controller`)
before 7.26beta1 and `cmr/not-a-controller` after.

| Build | What is known |
| ----- | ------------- |
| 7.26beta1 | Lab baseline: CMR1–CMR7 and CMR10–CMR18 pass over rest-api and native-api, CMR8–CMR9 over native-api. A login without `write` or `reboot` still writes through `run-script` (#456, CMR15). |
| 7.26beta3 | The manual's single credentialed `pair` can stop half-way: the client is `paired,connected`, but the controller's row keeps `state="pair: device:ok, cmr:ok"` and `run-script` never selects it (#527; quickchr FINDINGS.md → Pairing). The lab now runs a bare `/cmr/device/pair` before the credentialed one, and still finishes and warns if a row is left half-paired. A login without both `write` and `reboot` is refused by `run-script` (`not enough permissions (9)`), so CMR15 and CMR18 are refusals. First build after beta1: 7.26beta2 was never published. |
| 7.26beta4 | Inside a CMR script, `local-id` is no longer masked (CMR-D7) and a client-side `/user/add` runs (CMR11, CMR11b). `/cmr/vlan/add` requires `port-labels` (CMR17). |
| 7.26beta5 | Same as 7.26beta4. |

Each split is a constant in `test/integration/chr.ts` (`CMR_*_SINCE`), and
`execute-cmr.test.ts` asserts the side the running build is on. The suite
passes on 7.26beta1, 7.26beta3, 7.26beta4 and 7.26beta5 (2026-11-11), and on
7.26beta1 and 7.26beta5 again with the confirm-first pairing (2026-11-12). The
complete `bun run test:integration` tier passed on the 7.26beta5 default on
2026-11-12: 278 pass, 0 fail.

The lab defaults to 7.26beta5. `CMR_SINCE` remains the capability floor
(7.26beta1), and `CENTRS_CMR_VERSION` selects a historical build for triage.
Update the explicit lab pin as development builds progress (#527).

For each build checked, add a row above. rosetta's changelog search
(`category: cmr`) and a `/cmr` command diff between builds show what a beta
changed.

<!-- cspell:ignore Sergejs -->

## MikroTik forum context

These are attributed vendor statements, refreshed 2026-11-11, not additional
CHR acceptance evidence:

- [Sergejs on IPv6](https://forum.mikrotik.com/t/7-26beta-development-is-released/273582/75)
  clarifies that IPv6-only networks are supported; when both addresses are
  reachable, IPv4 is preferred. This lab uses IPv4 and does not verify IPv6.
- [Sergejs on caller policy](https://forum.mikrotik.com/t/7-26beta-development-is-released/273582/139)
  places the read-group refusal in beta2. beta2 was never published; beta3
  is the first build with it, so the boundary above is exact.
- [Sergejs on port selectors](https://forum.mikrotik.com/t/7-26beta-development-is-released/273582/188)
  warns that empty or unset VLAN `port-labels` can include the uplink and
  disconnect clients. CMR17 tests a disabled add, not enabled provisioning
  or clearing selectors on an existing rule; its beta4+ add refusal does
  not establish that those other paths are safe. Port mappings use commas
  between ports and `/` between labels on one port.
- [Sergejs on managed bridges](https://forum.mikrotik.com/t/7-26beta-development-is-released/273582/232)
  explains that server or VLAN-rule disable/enable rebuilds `cmr-bridge`
  with a new internal ID; manual VLAN/DHCP management configuration on it
  can become invalid. A plain reconnect alone does not rebuild it. Keep
  management on an interface CMR does not manage for that design.
- [His later announcement](https://forum.mikrotik.com/t/7-26beta-development-is-released/273582/248)
  says the next beta will reuse the client's existing enabled bridge,
  preserve manual configuration and require one enabled bridge. This is
  future behavior, not beta5 acceptance; re-test before changing the lab.
- [The earlier lab reply](https://forum.mikrotik.com/t/claude-and-codex-try-out-cmr-in-7-26beta-mostly-successful/273613/4)
  says disable/enable clearing pairing is intended, client `confirm` was
  frozen before release, and the stable upgrade rule deliberately follows
  stable even when older. These are not new support reports.

The half-paired state in the builds table is separate from those acknowledged
behaviors. Neither refreshed thread identifies it as intended or fixed. #527
retains the lab reproducer and recovery for a potential MikroTik report.
