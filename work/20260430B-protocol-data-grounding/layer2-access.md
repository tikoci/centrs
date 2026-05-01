# Discovery and layer-2 access notes

Layer-2 access matters because a RouterOS device may have an unreachable or
misconfigured IP stack while still being reachable by MAC address, similar to
the human WinBox/MAC-Telnet recovery workflow.

## MNDP

- MNDP uses UDP 5678 broadcast/multicast and has no authentication.
- A listener sends a small refresh datagram to UDP 5678 and receives TLV-encoded
  replies asynchronously; passive announcements are slower and should not be the
  only scan mode.
- Devices may announce once per interface, so one physical router can appear as
  multiple rows.
- Identity is not unique. Factory-default devices often advertise `MikroTik`.
- MAC address and IP address are the actionable fields for connection attempts.
- Absence from a short scan is not proof that a device is offline.
- `centrs` should treat MNDP as a hint source and keep provenance visible.
- RouterOS exposes its own read-only view through `/ip/neighbor`; the governing
  settings are under `/ip/neighbor/discovery-settings` and can restrict
  participating interfaces and protocols.
- A parser can be unit-tested from TLV fixtures, but live scans need port reuse
  and broadcast behavior that should be tested separately on macOS and Linux.

## MAC Telnet

- MAC Telnet is the planned emergency terminal path when IP access is broken.
- RouterOS MAC server settings are under `/tool/mac-server`; the client command
  is `/tool/mac-telnet`.
- The legacy POSIX implementation identifies UDP port 20561 as the MAC Telnet
  protocol port.
- RouterOS docs say the MAC Telnet client tries all active interfaces by default;
  RouterOS v7.22 adds an `interface=` option to restrict the client side.
- The local `haakonnessjoen/mac-telnet` reference provides `mactelnet`,
  `macping`, `mndp`, and `mactelnetd`.
- Implementation likely needs raw or link-layer socket behavior and a real L2
  lab; ordinary QEMU SLiRP host forwarding is not enough.
- Treat MAC Telnet as terminal/emergency access only until the packet session,
  retransmit, login, and terminal behavior are extracted from the C reference and
  validated in a lab.

## RoMON

- RoMON is a RouterOS management overlay under `/tool/romon`.
- RouterOS docs expose `discover`, `ping`, `ssh`, and `/tool/romon/port`.
- RoMON uses EtherType `0x88bf` and destination MAC `01:80:c2:00:88:bf`.
- RoMON can use secrets and interface-list controls.
- When RoMON is enabled, the default `all` port entry allows every interface to
  participate unless it is modified to forbid participation or add secrets.
- RoMON does not provide protocol encryption; secure application protocols such
  as SSH or secure WinBox provide encryption above the overlay.
- Bridge, multicast, VLAN, and switch-chip behavior matter. RouterOS v7.17 added
  dynamic ACL handling on supported switch chips, but topology mismatches can
  still prevent RoMON from working.
- More implementation evidence is needed before committing to adapter behavior;
  a useful lab likely needs at least two RouterOS nodes on a shared L2 segment.

## WinBox Terminal

- WinBox service reachability on TCP 8291 is a strong RouterOS liveness signal.
- WinBox Terminal is planned, but local implementation evidence is currently
  weak.
- Do not assume proprietary WinBox tooling is locally available or scriptable.
- Do not describe WinBox Terminal as grounded until a protocol implementation,
  scriptable tool, or packet-level reference is pinned.

## Follow-up research

- Locate or pin Wireshark dissectors for MNDP, MAC Telnet, RoMON, and WinBox.
- Extract protocol notes from the local MAC Telnet C implementation.
- Define a safe L2 lab topology for MAC-first targets on macOS and Linux.
- Decide how a `<device>` target can carry both IP and MAC identities without
  making MNDP or CDB data authoritative.
- Decide whether WinBox Terminal belongs in `centrs` itself, a launcher for
  existing tooling, or a documented non-goal until the protocol is grounded.
