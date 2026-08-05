/**
 * The frozen console-verb vocabulary for `explain`.
 *
 * A leaf DATA module with no imports, exactly like `menus.ts`, and for the same
 * reason: two modules on opposite sides of the dependency edge both need to ask
 * "is this word a verb?", and they must ask the SAME object. `verbsplit.ts`
 * decides the verb/menu boundary (Q6) and already imports `pathresolve.ts` for
 * the document context walk; `pathresolve.ts`'s R9 (#211) needs the vocabulary
 * to keep `menuNavPath` from claiming `/ip address print` as navigation. Holding
 * the set here rather than in `verbsplit.ts` keeps that a shared leaf instead of
 * an import cycle. `verbsplit.ts` re-exports both names, so the public surface
 * is unchanged.
 */

/**
 * FROZEN universal-verb vocabulary: thirteen console CRUD verbs that exist at
 * essentially every configuration menu and have not changed across 7.x. This is
 * deliberately NOT a schema — no menu structure, no per-menu verb list, no
 * version. Do not tune it against scoring output; the whole point is to price a
 * fixed list honestly (it is what ratifies decision 3, "no offline schema
 * snapshot").
 *
 * Lookups are CASE-SENSITIVE everywhere, which is the device's own reading:
 * RouterOS rejects `PRINT`. Both consumers must keep it that way or they can
 * disagree about the same statement.
 */
export const VERBS: ReadonlySet<string> = new Set([
	"add",
	"comment",
	"disable",
	"edit",
	"enable",
	"export",
	"find",
	"get",
	"move",
	"print",
	"remove",
	"set",
	"unset",
]);

/**
 * Root menus idiomatically written with a `:` sigil that take a SUB-MENU rather
 * than a positional operand. Measured, not guessed: over the frozen dev split,
 * directive statements with a 2+ token run split 2,088 at run[0] against 18 at
 * run[1], and every one of the 18 is `:log <level>`. `log` has been a root
 * directory since 7.9.2 (checked against the 7.9.2 / 7.20.8 / 7.23rc1 trees),
 * so the exception is version-stable. It is one word, not a schema — a second
 * entry would mean decision 3's fixed-vocabulary claim needs re-examining.
 */
export const SUBMENU_DIRECTIVES: ReadonlySet<string> = new Set(["log"]);
