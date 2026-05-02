# Goal: RouterOS layer-2 lab grounding

## Problem

MNDP, MAC Telnet, and RoMON all depend on layer-2 behavior that ordinary
IP-forwarded QEMU or REST tests cannot prove. `centrs` needs a safe lab strategy
before implementing MAC-first discovery, emergency terminal access, or RoMON
routed management behavior.

## Scope

- Define the smallest useful L2 topology for macOS and Linux.
- Decide which tests can run with `quickchr`, which require bridged/shared
  networking, and which may require hardware.
- Ground MNDP refresh/listen behavior, MAC Telnet session behavior, and RoMON
  multi-node behavior.
- Record security warnings for unauthenticated discovery, MAC server exposure,
  RoMON secrets, bridge/VLAN behavior, and interface scoping.

## Non-goals

- Implement MNDP, MAC Telnet, or RoMON adapters.
- Require L2 lab tests in normal unit test runs.
- Treat MNDP observations as authoritative inventory.

## Source material

- `work/20260430B-protocol-data-grounding/layer2-access.md`
- `work/20260430B-protocol-data-grounding/protocol-matrix.md`
- `routeros-mndp`, `routeros-sniffer`, and `routeros-qemu-chr` skills
- `/Users/amm0/Lab/Legacy/mac-telnet`
- `quickchr`, `mcp-monorepo/mcp-mikrotik`, and `mcp-tzsp` local references
