/**
 * #255 — sweep the REAL device operator surface.
 *
 * The issue asks for the operator axis to be grounded rather than transcribed,
 * for the reason #252 established: a doc table is a LOWER BOUND on what
 * RouterOS accepts, and #255's own device evidence already contradicts the
 * manual twice (`not` and `..` are not operators — they lex as bare words).
 *
 * ## Which oracle answers which question
 *
 * Two oracles, and they answer different questions. Every row below says which
 * one scored it, per `scripts/probes/AGENTS.md`.
 *
 * - **`:parse` IL names the operator and shows its operands.** IL is prefix
 *   form with the operator as the head of its node, so `(1+2)` comes back as
 *   `(<%% (+ 1 2) )` — the head is the operator's identity and the child count
 *   is its arity. This is the only oracle that can say `(> 1)` and `(2 > 1)`
 *   are the same spelling at two arities, which is the whole `(>…)` question.
 * - **`highlight` CANNOT name an operator, and must not be read as if it
 *   could.** Mined from `test/fixtures/explain/highlight-streams.slice.json`,
 *   its `syntax-meta` class covers `=` `"` `$` `[` `]` `{` `}` `(` `)` `;` `,`
 *   `/` and whitespace runs alongside `||` `&&` `!=` `.` `->` `~`: it is the
 *   device's RESIDUAL STRUCTURE class, not an operator class. Adjacent runs are
 *   also merged (`="`, `($`, `")+` each arrive as ONE token), so operator
 *   boundaries are not recoverable from it at all.
 *
 *   What `highlight` is good for is the one distinction that decided #255's two
 *   counterexamples: **is this token structure, or is it a word?** `not` and
 *   `..` class `variable-undefined`, which is the device saying "I lexed a
 *   variable reference here". That is why the class is captured for every
 *   candidate even though it can never name one.
 *
 * ## Where the candidates come from
 *
 * Three sources, unioned, because each is a floor:
 *
 * 1. the manual's operator list (a lower bound, transcribed on purpose so the
 *    sweep can contradict it);
 * 2. **plausible non-operators** — `not`, `..`, `xor`, `mod`, … — so the
 *    COMPLEMENT is grounded too. An allow-list built without scoring what the
 *    device rejects is the #252 mistake;
 * 3. the IL head census over the corpus
 *    (`bun run explain:operator-census --candidates`), which is the device's
 *    own vocabulary — including string-content noise the census cannot filter,
 *    which lands here and gets rejected, which is fine and cheap.
 *
 * ## The `$` trap
 *
 * `scripts/probes/AGENTS.md` forbids a bare `$` inside a `:parse "<input>"`
 * wrapper: RouterOS substitutes inside double quotes, so the device would parse
 * a DIFFERENT program than the row names (#269). But `$` is itself one of the
 * operators under test. It is passed as the device-grounded `\$` escape, and
 * every row records `deviceSource` — the exact bytes handed to the console —
 * next to `source`, the program the row is about. A row that cannot state both
 * is not written.
 *
 * Run: bun run explain:probe:operators [existing-chr-name]
 *      CHR_VERSION=7.24rc4 bun run explain:probe:operators
 */
import { readIlTree } from "../explain-operator-census.ts";
import { openChr, type ProbeChr, probeOutputPath } from "./chr.ts";

/** Same rejection predicate as the census and the integration tier. */
const CONSOLE_REJECTION =
	/^(syntax error|expected |missing |invalid |unknown |unexpected |no such |bad )/i;

async function exec(chr: ProbeChr, input: string): Promise<string> {
	const out = await chr.exec(input);
	const text =
		typeof out === "string"
			? out
			: String((out as { output?: unknown } | null)?.output ?? "");
	return text.replaceAll("\r\n", "\n");
}

/**
 * Escape a program into a RouterOS double-quoted string.
 *
 * `\$` is in the device-grounded escape set (`VALID_SINGLE` in
 * `src/explain/quoted-string.ts`, swept in #252), so a `$` CAN be delivered
 * literally — which is the only way to ask about `$` as an operator at all.
 * A newline is refused rather than escaped: every probe here is single-line,
 * and a multi-line one would put `(line N column M)` offsets in the answer
 * that the row has no way to explain.
 */
export function quoteForParse(src: string): string {
	if (src.includes("\n") || src.includes("\r"))
		throw new Error(`multi-line probe input: ${JSON.stringify(src)}`);
	return src
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$");
}

interface ParseResult {
	/** The program the row is about. */
	source: string;
	/** The exact console command the device received. */
	deviceSource: string;
	/** Raw `:put [:parse …]` output. */
	il: string;
	accepted: boolean;
	/** Head of the parsed expression node, or null when the shape is not that. */
	ilHead: string | null;
	/** Child count of that node. */
	ilArity: number | null;
	/**
	 * The head is the EMPTY string — RouterOS's unnamed juxtaposition node.
	 *
	 * This is the trap the `(1 zzz 2)` control exists to expose. A paren group
	 * whose items are merely space-separated still parses: the device builds an
	 * unnamed node over them and turns every bare word into a variable
	 * reference. So `(1 not 2)` is accepted — as `(  1 $not 2)` — and a probe
	 * that scores "accepted, and a node exists" calls `not` an operator. Nine
	 * spellings in this sweep are only ever accepted this way.
	 */
	juxtaposition: boolean;
	/**
	 * The device invented a `$` the source did not have.
	 *
	 * None of the candidate carriers contain a `$`, so any `$` in the IL means
	 * part of the spelling was lexed as a VARIABLE REFERENCE rather than as an
	 * operator: `(1 .. 2)` comes back `(  (. 1 $.) 2)`, which is `.` applied to
	 * a variable named `.`, not a range operator. Without this the `.` head
	 * would credit `..` with being one.
	 */
	residualVariable: boolean;
}

function wrap(src: string): string {
	return `:put [:parse "${quoteForParse(src)}"]`;
}

/**
 * Read the operator node out of a `:put [:parse "<expr>"]` result.
 *
 * The device wraps a parsed program in an apply node, so an expression comes
 * back as `(<%% (+ 1 2) )` — root `<%%`, first child the expression. Reading
 * `roots[0].children[0]` rather than searching for a head keeps the row honest:
 * when the shape is anything else the row reports `null` and publishes the raw
 * IL, instead of finding a matching head somewhere in the tree and calling that
 * the answer.
 */
function readOperatorNode(il: string): {
	head: string | null;
	arity: number | null;
} {
	const tree = readIlTree(il);
	const root = tree.roots[0];
	if (root === undefined) return { head: null, arity: null };
	const first = root.children[0];
	if (first === undefined || typeof first === "string")
		return { head: null, arity: null };
	return { head: first.head, arity: first.children.length };
}

const MARKER = (i: number): string => `#P${i}#`;

/**
 * Run many `:parse` probes per console round-trip.
 *
 * `:parse` never throws — it returns its diagnostic as a VALUE — so a rejected
 * probe cannot abort the batch, which is what makes batching safe here. Each
 * result is fenced by a printed marker; a chunk whose markers do not all come
 * back is re-run one probe at a time rather than being reported with holes.
 */
async function parseMany(
	chr: ProbeChr,
	sources: readonly string[],
	chunkSize = 20,
): Promise<ParseResult[]> {
	const results: ParseResult[] = [];
	for (let start = 0; start < sources.length; start += chunkSize) {
		const chunk = sources.slice(start, start + chunkSize);
		const command = chunk
			.map((src, i) => `:put "${MARKER(i)}"; ${wrap(src)}`)
			.join("; ");
		const out = await exec(chr, command);
		const parsed = splitMarkers(out, chunk.length);
		const complete = parsed.every((entry) => entry !== null);
		for (const [i, src] of chunk.entries()) {
			const il = complete
				? ((parsed[i] as string) ?? "")
				: (await exec(chr, wrap(src))).trim();
			results.push(describeParse(src, il));
		}
	}
	return results;
}

/** Split marker-fenced batch output into one raw result per probe. */
export function splitMarkers(output: string, count: number): (string | null)[] {
	const out: (string | null)[] = Array.from({ length: count }, () => null);
	const lines = output.split("\n");
	let current: number | null = null;
	let buffer: string[] = [];
	const flush = (): void => {
		if (current !== null && current < count)
			out[current] = buffer.join("\n").trim();
		buffer = [];
	};
	for (const line of lines) {
		const match = /^#P(\d+)#\s*$/.exec(line.trim());
		if (match) {
			flush();
			current = Number(match[1]);
			continue;
		}
		if (current !== null) buffer.push(line);
	}
	flush();
	return out;
}

function describeParse(source: string, il: string): ParseResult {
	const accepted = !CONSOLE_REJECTION.test(il);
	const node = accepted ? readOperatorNode(il) : { head: null, arity: null };
	return {
		source,
		deviceSource: wrap(source),
		il,
		accepted,
		ilHead: node.head,
		ilArity: node.arity,
		juxtaposition: node.head === "",
		// Compared against the SOURCE rather than assumed absent, so an op-axis
		// row that deliberately carries a `$` is not scored wrongly.
		residualVariable: il.includes("$") && !source.includes("$"),
	};
}

export type OperatorVerdict = "operator" | "lowered" | "not-an-operator";

/**
 * Decide what the device did with one spelling, from its carriers.
 *
 * Three answers, not two, because the device has three behaviors and
 * collapsing them loses the one that matters:
 *
 * - **`operator`** — some carrier produced a node whose head IS this spelling.
 * - **`lowered`** — some carrier produced a node with a different, non-empty
 *   head and no invented `$`. Two very different things land here and the
 *   promoted table has to say which: `&&` lowers to head `and` (an alias), and
 *   `<>` lowers to `(< 1 (> 2))` (RE-LEXED as two operators, one of them the
 *   deferred-expression `>`). Either way the spelling is not itself an operator
 *   name, and a table keyed on spelling would be wrong to record one.
 * - **`not-an-operator`** — everything else: rejected outright, juxtaposed, or
 *   accepted only by turning part of the spelling into a variable.
 *
 * The rule is `head === token`, with no alias table. An alias table would have
 * to be written from what the sweep is trying to discover.
 */
export function verdictOf(
	token: string,
	carriers: readonly ParseResult[],
): { verdict: OperatorVerdict; arities: number[]; heads: string[] } {
	const arities = new Set<number>();
	const heads = new Set<string>();
	let lowered = false;
	for (const c of carriers) {
		if (!c.accepted || c.ilHead === null || c.ilHead === "") continue;
		if (c.residualVariable) continue;
		if (c.ilHead === token) {
			heads.add(c.ilHead);
			if (c.ilArity !== null) arities.add(c.ilArity);
			continue;
		}
		lowered = true;
		heads.add(c.ilHead);
	}
	return {
		verdict:
			arities.size > 0 ? "operator" : lowered ? "lowered" : "not-an-operator",
		arities: [...arities].sort((a, b) => a - b),
		heads: [...heads].sort(),
	};
}

/** Per-character `highlight` classes for one input. */
async function highlightClasses(
	chr: ProbeChr,
	input: string,
): Promise<string[]> {
	const rows = (await chr.rest("/console/inspect", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ request: "highlight", input }),
	})) as { highlight?: string }[];
	return (rows[0]?.highlight ?? "").split(",").filter(Boolean);
}

interface HighlightRun {
	text: string;
	class: string;
	start: number;
	end: number;
}

/** Coalesce a per-character class list into maximal equal-class runs. */
export function coalesce(
	input: string,
	classes: readonly string[],
): HighlightRun[] {
	const runs: HighlightRun[] = [];
	for (let i = 0; i < input.length; i++) {
		const cls = classes[i] ?? "(none)";
		const last = runs.at(-1);
		if (last !== undefined && last.class === cls) {
			last.end = i + 1;
			last.text = input.slice(last.start, last.end);
			continue;
		}
		runs.push({ text: input[i] as string, class: cls, start: i, end: i + 1 });
	}
	return runs;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * The manual's operator list, transcribed VERBATIM so the sweep can contradict
 * it. Source: https://manual.mikrotik.com/docs/developer-guides/scripting/index.md#operators
 * — arithmetic, relational, logical, bitwise, concatenation, "other".
 */
const MANUAL_OPERATORS = [
	"+",
	"-",
	"*",
	"/",
	"%",
	"<",
	">",
	"=",
	"<=",
	">=",
	"!=",
	"!",
	"&&",
	"and",
	"||",
	"or",
	"in",
	"~",
	"|",
	"^",
	"&",
	"<<",
	">>",
	".",
	",",
	"->",
];

/**
 * Spellings the manual does NOT list, swept so the COMPLEMENT is grounded.
 *
 * `not` and `..` are here because #255 already has device evidence that they
 * are words, not operators; the rest are the shapes a reader coming from
 * another language would assume RouterOS has. A table built only from what the
 * docs list cannot say any of these is absent — it can only fail to mention
 * them, which is not the same claim.
 */
const PLAUSIBLE_NON_OPERATORS = [
	"not",
	"..",
	"xor",
	"mod",
	"is",
	"div",
	"band",
	"bor",
	"shl",
	"shr",
	"eq",
	"ne",
	"**",
	"//",
	"===",
	"<>",
	"+=",
	"++",
	"?",
	"?:",
];

/**
 * The undocumented forms the issue's own examples surfaced, plus the manual's
 * "other operators" that have no infix spelling.
 *
 * `$`, `[` and `]` cannot be asked with the generic carriers in any meaningful
 * way — `(1 $ 2)` is not the question — but leaving them out would let the
 * table imply the sweep considered them. They are swept generically for
 * completeness and answered properly by the op-axis rows below.
 */
const UNDOCUMENTED = ["<%%", "<%", "%%", "$", "]"];

/**
 * Heads the corpus IL census saw at least twice, pasted from
 * `bun run explain:operator-census --candidates` on the pinned snapshot.
 *
 * Kept as a literal rather than read at run time: a probe must ask the same
 * questions on every device it is pointed at, and re-reading the census would
 * silently change the sweep when the corpus pin moves. The word-shaped noise
 * (`any`, `array`, `as`, `at`, `for`, `none`, `outside`) is deliberately left
 * in — those are string content the census cannot filter, and scoring them
 * costs one probe each while grounding seven more non-operators.
 */
const CENSUS_HEADS = [
	"evl",
	"line",
	";",
	"[",
	"any",
	"array",
	"as",
	"at",
	"for",
	"none",
	"outside",
];

const CANDIDATES = [
	...new Set([
		...MANUAL_OPERATORS,
		...PLAUSIBLE_NON_OPERATORS,
		...UNDOCUMENTED,
		...CENSUS_HEADS,
	]),
];

/**
 * Carriers, applied to every candidate identically.
 *
 * Several operators are type-restricted — the bitwise set is IP-only, `~` wants
 * strings, `in` wants an array — so a single numeric carrier would score them
 * as rejected and produce a table that says the manual was wrong when it was
 * the probe that was. A candidate is an operator at an arity if ANY carrier at
 * that arity parses, and the row keeps every carrier's answer so which one
 * decided it is checkable.
 */
const CARRIERS: { id: string; arity: number; build: (t: string) => string }[] =
	[
		{ id: "binary-num", arity: 2, build: (t) => `(1 ${t} 2)` },
		{ id: "binary-str", arity: 2, build: (t) => `("a" ${t} "b")` },
		{ id: "binary-ip", arity: 2, build: (t) => `(1.2.3.4 ${t} 1.2.3.4)` },
		{ id: "binary-arr", arity: 2, build: (t) => `(1 ${t} {1;2})` },
		{ id: "binary-tight", arity: 2, build: (t) => `(1${t}2)` },
		{ id: "prefix-num", arity: 1, build: (t) => `(${t} 1)` },
		{ id: "prefix-tight", arity: 1, build: (t) => `(${t}1)` },
		{ id: "postfix-num", arity: 1, build: (t) => `(1 ${t})` },
		{ id: "alone", arity: 0, build: (t) => `(${t})` },
	];

/**
 * Controls, run once.
 *
 * `(1 zzz 2)` is the KNOWN-FAILING control: a harness that scores it as an
 * operator is measuring nothing, and the standing method note says to verify
 * against one rather than trust a green sweep.
 */
const CONTROLS = [
	{ id: "no-operator", source: "(1 2)" },
	{ id: "group", source: "(1)" },
	{ id: "bogus-word", source: "(1 zzz 2)" },
	{ id: "bogus-symbol", source: "(1 @@ 2)" },
	{ id: "empty-group", source: "()" },
];

/**
 * The `(>…)` / `<%%` axis, in scope per #255's comment thread.
 *
 * `(>EXPR)` builds a deferred expression whose `:typeof` is `op`, and `<%%`
 * applies one. The reason it belongs in an OPERATOR sweep rather than beside it
 * is the discriminator: `(2 > 1)` and `(> 1)` are the same spelling at two
 * arities, so a table keyed on spelling alone gets one of them wrong. The
 * corpus already shows head `>` at arities 0, 1 and 2.
 */
const OP_AXIS: { id: string; source: string; note: string }[] = [
	{ id: "defer-empty", source: "(>[])", note: "the corpus's own shape" },
	{ id: "defer-command", source: "(>[:put 1])", note: "a command body" },
	{
		id: "defer-array",
		source: '(>{"a"=1})',
		note: "issue example: yields a-1",
	},
	{ id: "defer-scalar", source: "(>1)", note: "no bracket, no brace" },
	{
		id: "defer-spaced",
		source: "(> 1)",
		note: "issue: parses where (< 1) does not",
	},
	{ id: "defer-bare", source: "(>)", note: "arity 0, seen in the corpus" },
	{ id: "defer-var", source: "(>$x)", note: "$ delivered as the \\$ escape" },
	{
		id: "defer-positional",
		source: "(>[:put $0])",
		note: "does $0 bind in a deferred body",
	},
	{ id: "relational", source: "(2 > 1)", note: "arity 2, the discriminator" },
	{ id: "apply-num", source: "(1 <%% 2)", note: "apply a non-op" },
	{
		id: "apply-brace",
		source: "($x <%% {1;2})",
		note: "issue's positional form",
	},
	{
		id: "apply-paren",
		source: "($x <%% (1,2))",
		note: "array-literal argument",
	},
	{ id: "apply-named", source: '($x <%% {a="b"})', note: "named argument" },
	{ id: "apply-empty", source: "($x <%% {})", note: "no arguments" },
	{
		id: "query-conjunction",
		source: "/ip address print where disabled=no dynamic=no",
		note: "the empty-head IL node the corpus census surfaced",
	},
	{
		id: "juxtaposition",
		source: "(1 2 3)",
		note: "the unnamed node, asked directly",
	},
	{
		id: "juxtaposition-word",
		source: "(1 zzz 2)",
		note: "a bare word inside it becomes $zzz",
	},
	{
		id: "substitution",
		source: "(1 + $x)",
		note: "`$` as the manual lists it",
	},
	{
		id: "bracket-substitution",
		source: ":put [:tostr 1]",
		note: "`[]` as the manual lists it",
	},
	{
		id: "grouping",
		source: "((1 + 2) * 3)",
		note: "`()` as the manual lists it",
	},
	{
		id: "member-access",
		source: '({"a"=1} -> "a")',
		note: "`->` on the shape it is for",
	},
	{
		id: "tight-dot-ip",
		source: "(1.2)",
		note: "spacing changes the LEXER: this is an IP literal, not concat",
	},
	{
		id: "tight-dot-time",
		source: "(.1)",
		note: "and this is a time literal",
	},
];

/**
 * Runtime rows: what a deferred expression IS, which `:parse` cannot say.
 *
 * `:typeof` is the oracle here, not IL — the issue's `[:typeof $v]="op"` test in
 * the menu script in the issue thread is the shape a consumer actually relies on.
 */
const RUNTIME: { id: string; source: string; expect: string }[] = [
	{
		id: "typeof-deferred",
		source: ":global f255 (>[:return 1]); :put [:typeof $f255]",
		expect: "op",
	},
	{
		id: "apply-positional",
		source: ":global f255 (>[:return ($1 + $2)]); :put ($f255 <%% {1;2})",
		// `<%%` binds positionals from $0, so with {1;2} it is $0=1, $1=2 and
		// $2 unset — 2, not 3. The first run of this probe expected 3, which was
		// the PROBE being wrong about the language, not the device.
		expect: "2",
	},
	{
		id: "apply-positional-zero",
		source: ':global f255 (>[:return "$0|$1|$2"]); :put ($f255 <%% {7;8})',
		expect: "7|8|",
	},
	{
		id: "do-block-positional-zero",
		// The SAME question for a `do={…}` function, where $0 is conventionally
		// the function's own name (the issue's menu script in the issue thread relies on that).
		// If the two disagree, `symbols.ts` rule S6 is classing one of them on
		// the other's evidence.
		source: ':global f255 do={:return "$0|$1|$2"}; :put [$f255 7 8]',
		expect: "(records whether do= and <%% index positionals the same way)",
	},
	{
		id: "apply-named-arg",
		source: ":global f255 (>[:return $a]); :put ($f255 <%% {a=5})",
		expect: "5",
	},
	{
		id: "deferred-array",
		source: ':global f255 (>{"a"=1}); :put $f255',
		expect: "a=1",
	},
	{
		id: "deferred-array-typeof",
		source: ':global f255 (>{"a"=1}); :put [:typeof $f255]',
		expect: "(records what a deferred array actually is)",
	},
	{
		id: "array-compare",
		source: ":put ({2;1} > {1;2;3})",
		expect: "(true only where array comparison landed)",
	},
];

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

interface CandidateRow {
	token: string;
	sources: string[];
	/** `:parse`, always — `highlight` cannot name an operator. */
	oracle: "parse+highlight";
	carriers: Record<string, ParseResult>;
	/** Arities the DEVICE reported for a node headed by this spelling. */
	operatorArities: number[];
	/** Every non-empty IL head the spelling produced, its own or another's. */
	ilHeads: string[];
	/** `highlight` on `:put (1 T 2)`: the RUN containing the token, not a byte. */
	highlight: {
		input: string;
		tokenAt: number;
		run: HighlightRun | null;
		/**
		 * Whether that run is exactly the token.
		 *
		 * Usually false, and that is the point: `highlight` merges adjacent
		 * same-class bytes, so ` and ` arrives as one run with its spaces and
		 * `="` as one run spanning two different syntactic things. A consumer
		 * cannot recover an operator boundary from this stream.
		 */
		runIsTokenExactly: boolean;
		classes: string[];
	};
	verdict: OperatorVerdict;
}

/**
 * The sweep, gated behind `import.meta.main`.
 *
 * Everything above this point is pure and importable, which is why the gate
 * exists: `test/unit/explain-operator-probe.test.ts` covers `verdictOf`, the
 * marker splitter, the run coalescing helper and the `$` escape. A module that
 * booted a CHR on import could not be tested at all — and `verdictOf` is
 * exactly the helper whose first version scored `not` as an operator.
 */
async function main(): Promise<void> {
	const reuse = process.argv[2];
	const chr = await openChr({
		reuse,
		name: "centrs-255ops",
		version: Bun.env["CHR_VERSION"] ?? "7.23.3",
	});
	try {
		const res = (await chr.rest("/system/resource")) as Record<string, string>;
		console.log(
			`CHR ${res["version"]} (${res["architecture-name"]}) build ${res["build-time"]}`,
		);
		console.log(
			`${CANDIDATES.length} candidates x ${CARRIERS.length} carriers, plus ` +
				`${CONTROLS.length} controls, ${OP_AXIS.length} op-axis rows, ` +
				`${RUNTIME.length} runtime rows\n`,
		);

		// --- controls first: a harness that passes the bogus rows measures nothing.
		const controlResults = await parseMany(
			chr,
			CONTROLS.map((c) => c.source),
		);
		const controls = CONTROLS.map((c, i) => ({
			...c,
			...(controlResults[i] as ParseResult),
		}));
		for (const c of controls)
			console.log(
				`CONTROL ${c.id.padEnd(14)} ${c.accepted ? "accept" : "REJECT"} head=${c.ilHead ?? "-"}/${c.ilArity ?? "-"}  ${c.il.slice(0, 60)}`,
			);
		// The known-failing control. `(1 zzz 2)` IS accepted — the device
		// juxtaposes and reads `zzz` as `$zzz` — so the check is not "did it
		// reject" but "did it produce a node this sweep would credit to `zzz`".
		// The first run of this probe failed exactly here, which is why the
		// check prints rather than being assumed to pass.
		const bogusWord = controls.find((c) => c.id === "bogus-word");
		if (bogusWord !== undefined) {
			const scored = verdictOf("zzz", [bogusWord]);
			console.log(
				`\ncontrol check: bogus-word scores "${scored.verdict}" ` +
					`(must be "not-an-operator"; it parses, as juxtaposition)\n`,
			);
		}

		// --- the candidate grid.
		const flat: { token: string; carrier: string; source: string }[] = [];
		for (const token of CANDIDATES)
			for (const carrier of CARRIERS)
				flat.push({ token, carrier: carrier.id, source: carrier.build(token) });
		const flatResults = await parseMany(
			chr,
			flat.map((entry) => entry.source),
		);

		const rows: CandidateRow[] = [];
		for (const token of CANDIDATES) {
			const carriers: Record<string, ParseResult> = {};
			for (const [i, entry] of flat.entries()) {
				if (entry.token !== token) continue;
				carriers[entry.carrier] = flatResults[i] as ParseResult;
			}
			const scored = verdictOf(token, Object.values(carriers));
			const input = `:put (1 ${token} 2)`;
			const tokenAt = ":put (1 ".length;
			const classes = await highlightClasses(chr, input);
			const run =
				coalesce(input, classes).find(
					(r) => r.start <= tokenAt && tokenAt < r.end,
				) ?? null;
			rows.push({
				token,
				sources: CARRIERS.map((c) => c.build(token)),
				oracle: "parse+highlight",
				carriers,
				operatorArities: scored.arities,
				ilHeads: scored.heads,
				highlight: {
					input,
					tokenAt,
					run,
					runIsTokenExactly: run?.text === token,
					classes,
				},
				verdict: scored.verdict,
			});
		}

		const TAG: Record<OperatorVerdict, string> = {
			operator: "OP     ",
			lowered: "LOWERED",
			"not-an-operator": "no     ",
		};
		for (const row of rows)
			console.log(
				`${TAG[row.verdict]} ${row.token.padEnd(6)} ` +
					`arities=${row.operatorArities.join(",") || "-"} `.padEnd(14) +
					`heads=${row.ilHeads.join(",") || "-"} `.padEnd(14) +
					`hl=${(row.highlight.run?.class ?? "-").padEnd(20)} ` +
					`run=${JSON.stringify(row.highlight.run?.text ?? "")}` +
					`${row.highlight.runIsTokenExactly ? "" : "  (run != token)"}`,
			);

		// --- precedence: only over spellings that took two operands.
		const binary = rows.filter((r) => r.operatorArities.includes(2));
		const pairs: { a: string; b: string; source: string }[] = [];
		for (const a of binary)
			for (const b of binary)
				pairs.push({
					a: a.token,
					b: b.token,
					source: `(1 ${a.token} 2 ${b.token} 3)`,
				});
		console.log(`\nprecedence: ${pairs.length} ordered pairs`);
		const pairResults = await parseMany(
			chr,
			pairs.map((p) => p.source),
		);
		const precedence = pairs.map((pair, i) => {
			const result = pairResults[i] as ParseResult;
			const tree = readIlTree(result.il);
			const root = tree.roots[0];
			const top = root?.children[0];
			const outer =
				top !== undefined && typeof top !== "string" ? top.head : null;
			// Which spelling ended up OUTERMOST is the answer: the outer operator is
			// the one that binds LOOSER. Heads, not spellings, because `&&` may lower
			// to `and` — the row carries both so the mapping stays checkable.
			const nested =
				top !== undefined && typeof top !== "string"
					? top.children
							.filter(
								(c): c is Exclude<typeof c, string> => typeof c !== "string",
							)
							.map((c) => c.head)
					: [];
			return {
				...pair,
				oracle: "parse" as const,
				il: result.il,
				accepted: result.accepted,
				outerHead: outer,
				innerHeads: nested,
			};
		});

		// A LOOSER-binding operator ends up outermost. Counting how often each
		// spelling was the outer one over every pair it appeared in gives a rank
		// without asserting a lattice the device never stated: a spelling that is
		// always outer binds loosest, one that never is binds tightest, and a
		// spelling in the middle is only ordered against the ones it was measured
		// against. Ties are real and left as ties.
		const outerCount = new Map<string, number>();
		const seenCount = new Map<string, number>();
		for (const row of precedence) {
			if (!row.accepted || row.outerHead === null || row.a === row.b) continue;
			// Attribution is exact rather than heuristic: the pair sweep only runs
			// over spellings whose verdict is `operator`, and that verdict requires
			// head === token, so the outer head IS one of the two spellings. A row
			// where it is neither (the device re-lexed the pair into something
			// else) is dropped rather than charged to a guess.
			if (row.outerHead !== row.a && row.outerHead !== row.b) continue;
			for (const token of [row.a, row.b])
				seenCount.set(token, (seenCount.get(token) ?? 0) + 1);
			outerCount.set(row.outerHead, (outerCount.get(row.outerHead) ?? 0) + 1);
		}
		console.log("\nprecedence (looser binding = outer more often):");
		for (const [token, seen] of [...seenCount].sort(
			(a, b) =>
				(outerCount.get(b[0]) ?? 0) / b[1] - (outerCount.get(a[0]) ?? 0) / a[1],
		))
			console.log(
				`  ${token.padEnd(6)} outer ${String(outerCount.get(token) ?? 0).padStart(3)}/${seen}`,
			);
		// Same operator twice: which side the device nested tells associativity.
		console.log("\nassociativity (1 A 2 A 3):");
		for (const row of precedence)
			if (row.a === row.b && row.accepted)
				console.log(`  ${row.a.padEnd(6)} ${row.il.slice(0, 60)}`);

		// --- the op / apply axis.
		const opResults = await parseMany(
			chr,
			OP_AXIS.map((entry) => entry.source),
		);
		const opAxis = OP_AXIS.map((entry, i) => ({
			...entry,
			oracle: "parse" as const,
			...(opResults[i] as ParseResult),
		}));
		console.log("");
		for (const row of opAxis)
			console.log(
				`OP-AXIS ${row.id.padEnd(18)} ${row.accepted ? "accept" : "REJECT"} ` +
					`head=${row.ilHead ?? "-"}/${row.ilArity ?? "-"}  ${row.il.slice(0, 80)}`,
			);

		// --- runtime rows, scored by execution rather than by IL.
		const runtime: Record<string, unknown>[] = [];
		for (const row of RUNTIME) {
			const output = (await exec(chr, row.source)).trim();
			runtime.push({ ...row, oracle: "exec", output });
			console.log(
				`RUNTIME ${row.id.padEnd(22)} expect=${row.expect.padEnd(10)} got=${JSON.stringify(output.slice(0, 60))}`,
			);
		}

		// `/system/resource` reports `7.23.3 (stable)`; the channel goes in the
		// capture, not in a filename a shell has to quote.
		const versionSlug = (res["version"] ?? "unknown").split(" ")[0];
		const outPath = await probeOutputPath(
			`explain-255-operator-sweep-${versionSlug}.json`,
		);
		await Bun.write(
			outPath,
			`${JSON.stringify(
				{
					issue: 255,
					version: res["version"],
					architecture: res["architecture-name"],
					buildTime: res["build-time"],
					capturedAt: new Date().toISOString(),
					method:
						"`:parse` IL names the operator and its arity; `highlight` can only " +
						"say structure-vs-word, because syntax-meta is a residual class and " +
						"its runs are merged. Every row names its oracle.",
					controls,
					candidates: rows,
					precedence,
					opAxis,
					runtime,
				},
				null,
				"\t",
			)}\n`,
		);
		console.log(`\nwrote ${outPath}`);
		for (const verdict of [
			"operator",
			"lowered",
			"not-an-operator",
		] as OperatorVerdict[])
			console.log(
				`${verdict.padEnd(16)} ${rows
					.filter((r) => r.verdict === verdict)
					.map((r) => r.token)
					.join(" ")}`,
			);
		console.log(
			`highlight runs that are exactly the token: ` +
				`${rows.filter((r) => r.highlight.runIsTokenExactly).length}/${rows.length}`,
		);
	} finally {
		if (!reuse) await chr.remove();
	}
}

if (import.meta.main) await main();
