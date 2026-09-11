/**
 * The `centrs → highlight` projection (#264 B4, measured by #263).
 *
 * `data.tokens[]` is a centrs-owned vocabulary; RouterOS
 * `/console/inspect request=highlight` is a *different* vocabulary produced by
 * a *different* kind of analyzer. This module is the declared bridge between
 * them, and it exists so the agreement report
 * (`scripts/explain-highlight-agreement.ts`) can say what offline analysis got
 * right against device truth instead of eyeballing two streams side by side.
 *
 * ## The projection is declared, never fitted
 *
 * Every entry below is justified by what the centrs class was *defined* to
 * mean — `commands/explain/README.md` → the token-census block and
 * `src/explain.ts`'s `ExplainTokenClass` doc — not by which device class it
 * happened to land on most often. A projection tuned to the measurement would
 * make the measurement circular: agreement would only ever say "the map was
 * fitted", which is not a fact about the parser. So a centrs class whose
 * *intent* has no single device counterpart projects to `null` and the report
 * counts those bytes as `unprojected`, reporting what the device said about
 * them as its own table. That table is the evidence #264 B5 needs to decide
 * whether a provisional merge deserves to be split.
 *
 * ## Why the device stream is not one oracle but four
 *
 * Scoring a byte requires knowing what kind of answer the device gave, and
 * `highlight` mixes four:
 *
 * - **syntax** — a class an offline analyzer can in principle decide from the
 *   source text alone (`cmd`, `dir`, `arg`, `comment`, the `variable-*`
 *   family, `escaped`, `syntax-meta`).
 * - **non-syntax** — `obj-inactive`, `obj-dynamic`, `obj-disabled`,
 *   `variable-undefined`, `syntax-obsolete`. The source text alone does not
 *   decide these, so they are reported as their own bucket and never as a
 *   wrong answer. Note what abstains: centrs has no class for most of them
 *   (`ExplainSymbolClass` excludes `undefined`), but where it *does* claim the
 *   byte — an `arg` the device calls `obj-inactive` — the token stands and it
 *   is the SCORER that declines to grade it. Saying *why* each one is out of
 *   reach is a separate question, and it is deliberately **not** answered by
 *   the class name — see `applicabilityOf` below.
 * - **silence** — `none`. The device assigned no class. It is the device's
 *   abstention, not a class named "none", so agreeing with it is not an
 *   agreement (probes: "an abstention is not a disagreement").
 * - **parser-stop** — `error`. Measured over the committed slice this byte
 *   appears **at most once per script, always exactly one byte wide**, and on
 *   7.23.2 every one of the 43,374 bytes after it is `none`: the device stops
 *   classifying rather than recovering. Half the slice's bytes sit in that
 *   tail, so a percentage that ignores it measures the device giving up.
 *
 * ## Upstream drift
 *
 * `DEVICE_CLASS_KIND` lists the 19 classes the phase-0 capture observed on
 * 7.23.2 / 7.24rc2. A class outside it is `"unknown"` — reported, never
 * silently folded into one of the four kinds — because a new upstream class is
 * exactly the drift the centrs-owned vocabulary exists to absorb, and guessing
 * its kind would hide it.
 */

import type { ExplainTokenClass } from "../explain.ts";

/**
 * What kind of answer a device highlight class is, from an offline analyzer's
 * point of view. See the module header for why the distinction is load-bearing.
 */
export type DeviceClassKind =
	| "syntax"
	| "non-syntax"
	| "silence"
	| "parser-stop"
	| "unknown";

/**
 * The 19 classes the Q13 capture observed, by kind.
 *
 * Source: `test/fixtures/explain/highlight-streams.slice.json` →
 * `selection.classesInCapture`, which the slice's own integrity test pins
 * against the stream data. Keep the two in step: the agreement report fails
 * loudly when the slice carries a class this table does not name.
 */
export const DEVICE_CLASS_KIND: Readonly<Record<string, DeviceClassKind>> = {
	arg: "syntax",
	"arg-dot": "syntax",
	"arg-scope": "syntax",
	cmd: "syntax",
	comment: "syntax",
	dir: "syntax",
	escaped: "syntax",
	"syntax-meta": "syntax",
	"variable-auto": "syntax",
	"variable-global": "syntax",
	"variable-local": "syntax",
	"variable-parameter": "syntax",
	"obj-disabled": "non-syntax",
	"obj-dynamic": "non-syntax",
	"obj-inactive": "non-syntax",
	"syntax-obsolete": "non-syntax",
	"variable-undefined": "non-syntax",
	none: "silence",
	error: "parser-stop",
};

/** The kind of a device class; `"unknown"` for anything the capture never saw. */
export function deviceClassKind(deviceClass: string): DeviceClassKind {
	return DEVICE_CLASS_KIND[deviceClass] ?? "unknown";
}

/**
 * One projection entry: the device classes a centrs class predicts, plus the
 * reason it predicts them. `accepts: null` is a deliberate abstention.
 */
export interface ProjectionEntry {
	/** Device classes this centrs class claims, or `null` to abstain. */
	readonly accepts: readonly string[] | null;
	/** Why — in terms of what the centrs class was defined to mean. */
	readonly because: string;
}

/**
 * centrs token class → the device highlight classes it predicts.
 *
 * Total over `ExplainTokenClass`: every class has an entry, and an entry is
 * either a non-empty accept set or an explicit abstention.
 */
export const HIGHLIGHT_PROJECTION: Readonly<
	Record<ExplainTokenClass, ProjectionEntry>
> = {
	comment: {
		accepts: ["comment"],
		because:
			"name-coincident: the class was taken from the device vocabulary and means the same run of source",
	},
	"variable-local": {
		accepts: ["variable-local"],
		because: "name-coincident (the Q13 symbol classes are the device's own)",
	},
	"variable-global": {
		accepts: ["variable-global"],
		because: "name-coincident (the Q13 symbol classes are the device's own)",
	},
	"variable-auto": {
		accepts: ["variable-auto"],
		because: "name-coincident (the Q13 symbol classes are the device's own)",
	},
	"variable-parameter": {
		accepts: ["variable-parameter"],
		because: "name-coincident (the Q13 symbol classes are the device's own)",
	},
	dir: {
		accepts: ["dir"],
		because:
			"name-coincident: resolved menu bytes, leading `/` or `:` included, which is the run the device also calls `dir`",
	},
	cmd: {
		accepts: ["cmd"],
		because: "name-coincident: the resolved command-name run",
	},
	arg: {
		accepts: ["arg", "arg-dot", "arg-scope"],
		because:
			"argument-name bytes; the device splits dotted spellings (`.id`, `security.authentication-types`) into `arg-dot` / `arg-scope` and centrs deliberately does not, so all three are the same claim. The `=` byte the class also merges in is NOT covered — the device reads it as `syntax-meta`, and that mismatch is a measured cost of the merge, not a lexer fault (#264 B5)",
	},
	operator: {
		accepts: ["syntax-meta"],
		because:
			"`syntax-meta` is the device's residual structure class and the only place an operator byte can land (#255): the device merges adjacent structure runs, so it names no operator boundary, but it does decide structure-versus-word",
	},
	brace: {
		accepts: ["syntax-meta"],
		because:
			"scope and array delimiters are structure punctuation, and `syntax-meta` is the device's only class for it",
	},
	string: {
		accepts: null,
		because:
			"the token spans the whole quoted run, which the device splits three ways — delimiters `syntax-meta`, escape sequences `escaped`, and the interior it declines to classify at all. No single device class answers for the run",
	},
	value: {
		accepts: null,
		because:
			"the device has no value class. It classifies an argument's value only when the value is itself something else (a substitution, an object name), so a `value` token has no device counterpart to be right or wrong about",
	},
	unclassified: {
		accepts: null,
		because: "centrs's own abstention — no analyzer claimed the byte",
	},
};

/** The device classes a centrs class predicts, or `null` where it abstains. */
export function projectTokenClass(
	tokenClass: ExplainTokenClass,
): readonly string[] | null {
	return HIGHLIGHT_PROJECTION[tokenClass].accepts;
}

/**
 * Why a device answer is or is not within reach of offline analysis (#263).
 *
 * This is a **second axis**, orthogonal to whether a byte agreed. Agreement
 * asks "did the two answers match"; applicability asks "what kind of fact was
 * the device deciding, and could source text alone have decided it". A byte
 * has one of each.
 *
 * The categories are #263's, and the load-bearing instruction there is that
 * they are assigned **from context, never by assigning a whole highlight class
 * to one bucket**. So the input is the *pair* — what centrs read the byte as
 * and what the device called it — plus whether the captured versions even
 * agreed on the device's answer.
 */
export type Applicability =
	/** Syntax and structure justify the conclusion; offline analysis can reach it. */
	| "offline-decidable"
	/** Needs a per-path field/argument schema offline centrs deliberately does not ship. */
	| "schema-dependent"
	/** Needs runtime objects or session state outside the input. */
	| "state-dependent"
	/** The captured RouterOS versions disagree, so there is no single device answer. */
	| "version-dependent"
	/** No supported basis for a category. Explicit, never a silent default. */
	| "uncategorized"
	/** The device gave no answer here (`none`, or the post-`error` tail). */
	| "no-device-answer";

/**
 * Categorize one byte's device answer.
 *
 * `versionsAgree` is whether every captured version gave this byte the same
 * class. It is checked **first**, ahead even of the device's own silence: when
 * the captures disagree there is no single device answer to be schema- or
 * state-dependent about, and the disagreement is itself the fact worth
 * reporting. That ordering matters in practice — a byte one build classifies
 * and the next leaves `none` is a version difference, not an absence, and
 * checking silence first would file it as "the device said nothing" on the
 * strength of whichever build happens to be the base.
 */
export function applicabilityOf(
	centrsClass: string,
	deviceClass: string,
	versionsAgree: boolean,
): Applicability {
	if (!versionsAgree) return "version-dependent";
	const kind = deviceClassKind(deviceClass);
	if (kind === "silence" || kind === "parser-stop") return "no-device-answer";
	if (kind === "syntax") return "offline-decidable";
	// `syntax-obsolete` is the running version's deprecation table talking: the
	// same bytes are unremarkable on an older build. Measured on the slice it
	// lands on the whitespace where modern syntax wants `=` (`} else {`,
	// `:foreach conn in $conns`).
	if (deviceClass === "syntax-obsolete") return "version-dependent";
	if (deviceClass === "obj-dynamic" || deviceClass === "obj-disabled")
		return "state-dependent";
	if (deviceClass === "obj-inactive") {
		// Same class, two different reasons — which is exactly why the class name
		// cannot decide the category. On a name centrs read as an argument, the
		// device is saying the menu's schema has no such field; on a menu or
		// command name it is saying the package or menu is not present on this
		// box.
		if (centrsClass === "arg") return "schema-dependent";
		if (centrsClass === "dir" || centrsClass === "cmd")
			return "state-dependent";
		return "uncategorized";
	}
	// `variable-undefined` is NOT blanket state-dependent (#263, explicitly). A
	// bare word the device resolved to an undefined reference may be an external
	// global, a query/filter field name, or a lexical spelling — three different
	// categories — and nothing committed here separates them. Equally, an absent
	// binding in this document is not evidence of a runtime undefined variable.
	// Leaving it explicit is the point; folding it into a category would be the
	// unsupported claim.
	//
	// This branch reaches the same answer as the fallthrough below on purpose:
	// the requirement belongs at the point of decision, where the next reader
	// making a rule for this class will be standing, not only in the prose. It
	// is pinned by a test.
	if (deviceClass === "variable-undefined") return "uncategorized";
	// Any other non-syntax class, and any class this build has never seen: no
	// supported basis for a category, said out loud rather than guessed.
	return "uncategorized";
}
