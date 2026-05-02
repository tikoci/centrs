# Plan: Wireshark dissector inventory

## Approach

Pin references first, then decide whether they are useful enough to influence
protocol notes or fixture validation.

## Workstreams

1. Source inventory
   - Find MNDP, MAC Telnet, RoMON, and WinBox dissectors.
   - Record upstream versus third-party status.
   - Record license and version/pin information.

2. Coverage review
   - Note which message types each dissector understands.
   - Compare coverage to local tikoci code and RouterOS docs.

3. Usage policy
   - Decide when dissectors are supporting evidence versus primary evidence.
   - Define safe packet-capture handling for future work items.
