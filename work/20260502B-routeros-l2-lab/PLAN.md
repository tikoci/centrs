# Plan: RouterOS layer-2 lab grounding

## Approach

Separate parser/unit-test evidence from live L2 behavior. Define lab shapes first,
then decide which behaviors can become gated integration tests.

## Workstreams

1. MNDP lab shape
   - Verify UDP 5678 refresh/listen behavior.
   - Record multi-interface announcements and identity ambiguity.
   - Decide macOS and Linux port-reuse requirements.

2. MAC Telnet lab shape
   - Extract packet/session notes from the local C implementation.
   - Identify required socket privileges and interface selection behavior.
   - Decide whether an external tool or pure TypeScript implementation is viable.

3. RoMON lab shape
   - Define a minimum two-router shared-L2 topology.
   - Test EtherType `0x88bf`, secrets, bridge/VLAN behavior, and RoMON `ssh`.
   - Record what cannot be tested through ordinary host port forwarding.

4. Test strategy
   - Keep TLV/parser fixtures in unit tests.
   - Keep long-running or privileged L2 behavior in opt-in integration/lab tests.
   - Link any future implementation spec to this work item.
