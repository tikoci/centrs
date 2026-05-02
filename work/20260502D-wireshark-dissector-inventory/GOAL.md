# Goal: Wireshark dissector inventory

## Problem

Packet-level RouterOS protocol work needs independent wire-format references.
The 20260430B work item identified dissectors as useful but did not pin exact
sources for MNDP, MAC Telnet, RoMON, and WinBox.

## Scope

- Identify upstream or third-party dissectors for MNDP, MAC Telnet, RoMON, and
  WinBox.
- Record license, maintenance status, and protocol coverage.
- Decide how dissector behavior should be used when it conflicts with RouterOS
  docs, local captures, or reference implementations.

## Non-goals

- Vendor dissector code.
- Treat dissector behavior as authoritative without lab confirmation.
- Capture or commit sensitive packet data.

## Source material

- `work/20260430B-protocol-data-grounding/references.md`
- `work/20260430B-protocol-data-grounding/layer2-access.md`
- `mcp-tzsp` and `routeros-sniffer` references for safe capture workflows
