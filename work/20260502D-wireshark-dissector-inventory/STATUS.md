# Status: Wireshark dissector inventory

## Current state

- Work item created from the May 1 protocol/data grounding review.
- A WinBox dissector lead and MAC Telnet Wireshark page are known.
- MNDP and RoMON dissector coverage still needs source-pinning.

## Open questions

- Which dissectors are upstream Wireshark and which are third-party?
- Which dissectors are current enough for RouterOS v7 behavior?
- How should conflicts between dissector output, RouterOS docs, and local lab
  captures be resolved?

## Deferred

- No packet captures should be committed unless scrubbed and explicitly safe.
