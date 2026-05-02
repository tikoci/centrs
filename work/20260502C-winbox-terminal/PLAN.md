# Plan: WinBox Terminal feasibility

## Approach

Determine whether there is enough open, scriptable evidence to keep WinBox
Terminal in the implementation roadmap.

## Workstreams

1. Reference inventory
   - Pin terminal-over-WinBox code references.
   - Check dissector coverage for terminal messages.
   - Record license and maintenance concerns.

2. Feasibility test shape
   - Determine whether CHR plus TCP 8291 is sufficient for a liveness-only test.
   - Identify what extra evidence is needed for terminal I/O behavior.

3. Decision
   - Choose adapter, external launcher, or deferred non-goal.
   - Update S002/S006 only if the decision affects planned protocol capability.
