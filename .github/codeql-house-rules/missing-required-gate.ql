/**
 * PILOT / UNVERIFIED — see issue #119. Not run yet against real CodeQL
 * analysis; expect to need at least one tuning pass once real output exists.
 *
 * Structural check, not data-flow: "named entry-point function must contain
 * a call to its named gate function." Deliberately per-function/existence-only
 * rather than taint-tracked, so it can't fall into the same over-tainting trap
 * that produced this repo's ~30 dismissed js/clear-text-logging false
 * positives (shared helpers making CodeQL treat unrelated values as tainted).
 * The tradeoff: this only catches "the gate call was deleted/never added," not
 * "the gate call runs after the sink" ordering bugs — a real limitation.
 *
 * Encodes two docs/CONSTITUTION.md rules, scoped to their one clean instance
 * (api-fanout.ts) as the pilot case:
 *   - "Do not silently fall back to another protocol when --via is pinned"
 *     -> apiFanout must call assertApiProtocolSupported.
 *   - "Validation is the product; do not disable it to make a test pass"
 *     -> apiFanout must call validateApiRequestShape.
 *
 * Caveat: getCalleeName() matches the call as syntactically written. A future
 * refactor that calls the gate through a namespace/alias (e.g.
 * `api.assertApiProtocolSupported(...)`) would not match this string
 * comparison and would produce a false alarm — untested against that shape.
 *
 * @name CLI entry point missing its required validation/protocol gate
 * @description Flags a named entry-point function that no longer calls a
 *   house-rule gate function it is required to call.
 * @kind problem
 * @problem.severity error
 * @id centrs/missing-required-gate
 * @tags maintainability
 *       correctness
 */

import javascript

/** A (entry-point function name, required gate call name) house rule. */
predicate requiredGate(string entryPointName, string gateName) {
  entryPointName = "apiFanout" and gateName = "assertApiProtocolSupported"
  or
  entryPointName = "apiFanout" and gateName = "validateApiRequestShape"
}

from Function entryPoint, string entryPointName, string gateName
where
  entryPoint.getName() = entryPointName and
  requiredGate(entryPointName, gateName) and
  not exists(CallExpr call |
    call.getEnclosingFunction() = entryPoint and
    call.getCalleeName() = gateName
  )
select entryPoint,
  "`" + entryPointName + "` no longer calls the required gate `" + gateName + "`."
