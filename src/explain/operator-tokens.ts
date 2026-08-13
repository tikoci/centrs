/**
 * B2 operator fill — claims operator bytes on the residual.
 *
 * This is the first B2 fill of #264. It runs **after** the proof-only spans
 * (`comment` + `variable-*`) and sees only the residual left by them — fill
 * order is structural, not lexical (#290 design decision 1). `/` that is a path
 * separator, `,` that is an argument separator, `=` that is a name separator
 * and `-` that is a hyphen in a name are resolved by who claimed the byte
 * first, not by a smarter operator scanner.
 *
 * Two-hop census note: operator's abstention leaves some bytes `unclassified`
 * that a future path/arg fill will claim. That means the classified percentage
 * jumps twice for those bytes (now `unclassified`→stays, later
 * `unclassified`→`path`/`arg`), which is correct — don't misread the later diff
 * as "operator stole bytes".
 *
 * ## Abstention is the same rule three times
 *
 * A byte that is structurally part of a **path** or an **argument** belongs to
 * a later fill, so this fill leaves it alone. Grounded on the corpus device
 * oracle (`parseil_results.il_text`, the IL RouterOS actually parsed to):
 *
 * 1. **`[` is command substitution, not expression grouping.** `(` opens an
 *    expression; `[` opens a *command* and `{` a block/array literal. The IL
 *    for `[ /system/identity/get value-name=name ]` is
 *    `(evl /system/identity/get value-name=name)` — the `/` are path
 *    separators and the `=` is an argument separator, with no division and no
 *    comparison node. So the `, / = -` conservatism holds everywhere except
 *    directly inside `(`. Measured cost: `find where name="x"` inside `[…]`
 *    *does* lower to a real `(= $name x)` node, and those `=` bytes now stay
 *    `unclassified` — 224 of the corpus's 1,259 bracket `=` against 1,035 that
 *    were plain `arg=value`. Abstaining on all of them beats claiming 82%
 *    wrong; a `where`-aware fill can take them later.
 * 2. **Glued after `=` is an argument value.** `in-interface-list=!LAN`,
 *    `.id=*2`, `oid=.1.3.6.1.2.1` — the byte after an argument `=` starts the
 *    value, never an operator.
 * 3. **Glued into an argument name is a name byte.** `:foreach x in=$list` is
 *    `/foreach counter=$x` in the IL with **no** `(in …)` node anywhere — `in=`
 *    is an argument name. Same for the dotted names: the IL keeps
 *    `security.authentication-types=wpa2-psk` as one name and renders `.id` as
 *    the single symbol `$.id`, never a `(. …)` concat.
 *
 * Vocabulary is provisional: one `operator` class for all 26 spellings + the
 * two aliases (`&&`, `||`). Per-operator/per-category legend is #264 B5.
 * `<>` is **not** one token — it re-lexes to `<` then `>` as two tokens.
 * `syntax-meta` is residual and merged, never a source (#255).
 */

import type { ExplainToken } from "../explain.ts";
import { loweredSpellings, routerosOperators } from "./operators.ts";
import { scanQuotedString } from "./quoted-string.ts";

const WORD_OPERATORS = new Set(["and", "or", "in", "any"]);
/**
 * Spellings that are only operators inside an expression group — everywhere
 * else they are path separators, argument separators or hyphens in a name.
 * `->` is never ambiguous and is deliberately absent.
 */
const EXPRESSION_ONLY = new Set([",", "/", "=", "-"]);

/** The only opener that starts an expression. `[` is a command, `{` a block. */
const EXPRESSION_OPENER = "(";
const OPENERS = "([{";
const CLOSERS = ")]}";

const PUNCT_ONLY_DOT_GUARD = ".";

function isDigit(c: string): boolean {
	return c >= "0" && c <= "9";
}

function isSpace(c: string): boolean {
	return c === " " || c === "\t" || c === "\r" || c === "\n";
}

// Spellings to scan for. Hard-coded from the grounded table; no regex.
function buildSpellings(): string[] {
	const ops = routerosOperators().map((o) => o.spelling);
	const aliases = loweredSpellings()
		.filter((e) => e.kind === "alias")
		.map((e) => e.spelling);
	// `<>` is re-lexed, not one token — exclude it.
	const all = [...ops, ...aliases].filter((s) => s !== "<>");
	// Deduplicate, longest first.
	const uniq = [...new Set(all)];
	uniq.sort((a, b) => b.length - a.length || b.localeCompare(a));
	return uniq;
}

const SPELLINGS = buildSpellings();

function isWordOperator(spelling: string): boolean {
	return WORD_OPERATORS.has(spelling);
}

/**
 * `=` immediately to the left — everything after an argument `=` is the value
 * (`in-interface-list=!LAN`, `.id=*2`, `oid=.1.3.6.1.2.1`), never an operator.
 */
function followsArgumentEquals(analyzed: string, start: number): boolean {
	return start > 0 && analyzed[start - 1] === "=";
}

/**
 * The spelling is glued into an argument NAME, which ends at its `=`.
 *
 * Two grounded shapes: a word operator immediately before `=` (`in=$list` in
 * `:foreach`), and a dot that joins name parts (`.id=`, `.passphrase=`,
 * `configuration.ssid=`, `security.authentication-types=`). Deliberately not
 * generalized to every spelling — `<`/`>`/`-` before an `=` have no grounded
 * name shape and generalizing would abstain on real comparisons.
 */
function insideArgumentName(
	analyzed: string,
	start: number,
	spelling: string,
): boolean {
	const after = start + spelling.length;
	if (isWordOperator(spelling)) return analyzed[after] === "=";
	if (spelling !== PUNCT_ONLY_DOT_GUARD) return false;
	// `.` + at least one name character, then the `=` that ends the name.
	let p = after;
	if (p >= analyzed.length || !/[A-Za-z]/.test(analyzed[p] as string))
		return false;
	while (p < analyzed.length && /[A-Za-z0-9._-]/.test(analyzed[p] as string))
		p++;
	return analyzed[p] === "=";
}

function isAllResidual(
	start: number,
	len: number,
	isResidual: (pos: number) => boolean,
): boolean {
	for (let p = start; p < start + len; p++) if (!isResidual(p)) return false;
	return true;
}

/**
 * Operator spans on the residual.
 *
 * `analyzed` is the ASCII-normalized document text; `residual` is the gap set
 * left by earlier fills (already sorted, no overlaps). Every emitted span's
 * bytes are fully inside `residual`, sorted by `start`, non-overlapping, and
 * carry `class: "operator"` + `ev: "e10"`.
 */
export function operatorSpans(
	analyzed: string,
	residual: readonly { start: number; end: number }[],
): ExplainToken[] {
	const len = analyzed.length;
	if (len === 0 || residual.length === 0) return [];

	// Fast residual membership — residual is sorted.
	function isResidual(pos: number): boolean {
		// Binary search over residual ranges.
		let lo = 0;
		let hi = residual.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const r = residual[mid] as { start: number; end: number };
			if (pos < r.start) hi = mid - 1;
			else if (pos >= r.end) lo = mid + 1;
			else return true;
		}
		return false;
	}

	const out: ExplainToken[] = [];
	// Delimiter stack, not a depth counter: only `(` opens an expression, so the
	// innermost opener — not the nesting level — decides `EXPRESSION_ONLY`.
	const openers: string[] = [];
	let i = 0;

	while (i < len) {
		const ch = analyzed[i] as string;

		// String interior — skip entirely, no delimiter accounting inside.
		if (ch === '"' && isResidual(i)) {
			const scan = scanQuotedString(analyzed, i);
			if (scan.end > i + 1) {
				i = scan.end;
				continue;
			}
			// Unterminated double-quoted string — advance one so the scan makes progress
			i++;
			continue;
		}

		const residualAt = isResidual(i);

		// Delimiter tracking — only when the byte itself is residual. A `(` or `[`
		// inside a comment/variable is not residual and does not open anything.
		// This is the conservatism signal for `, / = -`.
		if (residualAt && OPENERS.includes(ch)) {
			openers.push(ch);
			i++;
			continue;
		}
		if (residualAt && CLOSERS.includes(ch)) {
			openers.pop();
			i++;
			continue;
		}

		if (!residualAt) {
			i++;
			continue;
		}

		// Everything after an argument `=` is that argument's value — no operator
		// starts there. Checked once per offset, not once per spelling.
		if (followsArgumentEquals(analyzed, i)) {
			i++;
			continue;
		}

		// Try longest-match operator at i.
		let matched: string | null = null;
		for (const spell of SPELLINGS) {
			if (i + spell.length > len) continue;
			// Quick first-char filter
			if (analyzed[i] !== spell[0]) continue;
			if (analyzed.slice(i, i + spell.length) !== spell) continue;
			if (!isAllResidual(i, spell.length, isResidual)) continue;

			if (isWordOperator(spell)) {
				const before = i > 0 ? analyzed[i - 1] : undefined;
				const after =
					i + spell.length < len ? analyzed[i + spell.length] : undefined;
				if (before !== undefined && /[A-Za-z0-9._-]/.test(before)) continue;
				if (after !== undefined && /[A-Za-z0-9._-]/.test(after)) continue;
			}

			if (spell === PUNCT_ONLY_DOT_GUARD) {
				// `1.` variable name — dot glued to left alnum and followed by
				// space / close delimiter / end. (1. 2) -> $1. juxtaposition.
				if (i > 0 && /[A-Za-z0-9]/.test(analyzed[i - 1] as string)) {
					const right = i + 1 < len ? analyzed[i + 1] : undefined;
					if (
						right === undefined ||
						isSpace(right) ||
						right === ")" ||
						right === "]" ||
						right === "}" ||
						right === ";" ||
						right === "," ||
						right === '"' ||
						right === "'"
					) {
						continue;
					}
				}
				// Tight digit.digit — IP literal 1.2, no spaces.
				if (
					i > 0 &&
					i + 1 < len &&
					isDigit(analyzed[i - 1] as string) &&
					isDigit(analyzed[i + 1] as string)
				) {
					continue;
				}
				// Time literal (.1) — dot immediate after '(' and before digit.
				if (
					i > 0 &&
					analyzed[i - 1] === "(" &&
					i + 1 < len &&
					isDigit(analyzed[i + 1] as string)
				) {
					continue;
				}
				// Second byte of `..` — variable `$.` re-lex.
				if (i > 0 && analyzed[i - 1] === ".") continue;
			}

			if (spell === "/") {
				if (i > 0 && analyzed[i - 1] === "/") continue;
			}

			// Glued into an argument name (`in=`, `.id=`, `configuration.ssid=`).
			if (insideArgumentName(analyzed, i, spell)) continue;

			// Expression-only conservatism — leaves `, / = -` for the path/arg
			// fills everywhere except directly inside `(`. `->` is always allowed.
			if (
				EXPRESSION_ONLY.has(spell) &&
				openers[openers.length - 1] !== EXPRESSION_OPENER
			)
				continue;

			matched = spell;
			break;
		}

		if (matched !== null) {
			out.push({
				start: i,
				end: i + matched.length,
				class: "operator" as const,
				ev: "e10",
			});
			i += matched.length;
			continue;
		}

		i++;
	}

	return out;
}
