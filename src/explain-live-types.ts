/**
 * Live value types for explain (#225): `observedType` from a visible `:parse`
 * conversion and `schemaType` from argument-level `syntax`. Read-only; nothing
 * the user wrote is evaluated, and no `:typeof` is sent.
 *
 * ## observedType: only a conversion is evidence
 *
 * `:parse` prints a string unquoted, so `:local a 123` and `:local b "123"`
 * both render `value=123`, and `"2.2"` renders `2.2`. A rendering therefore
 * names a type only when the device CHANGED the literal: `2.2` → `2.0.0.2`
 * (ip), `0x10` → `16` and `0123` → `123` (num), `yes` → `true` (bool),
 * `200ms` → `00:00:00.200` and `1:2` → `01:02:00` (time), `1:0:0::1` →
 * `1::1` (ip6). An unchanged rendering (`123`, `1.1.1.1`, `true`, `abc`,
 * `100000w`) is an abstention, as is a rendering no type explains (`$abc`, a
 * member read as a variable; `(- 1)`, a member read as an expression).
 *
 * The literal is not located in the IL of the user's input: strings print raw,
 * so a quoted `"x;y=1"` is indistinguishable from two arguments there. Each
 * bare literal is instead re-parsed alone, in a probe centrs builds from a
 * restricted byte set: `:local vN <lit>` for a scripting operand and
 * `:local vN {<lit>}` for an array member, joined by `;` into one escaped
 * `:put [:parse "…"]`. `:put <lit>` converts identically to `:local`. One
 * hard-error member (`{*1}`) rejects its whole batch, so members and operands
 * are separate batches and a rejected batch abstains with its reason.
 *
 * Menu-command arguments are excluded. Their values are converted by the
 * argument's own parser, which prints a per-argument encoding
 * (`src-address=!1.1.1.1` → `true;1.1.1.1`, `address=2.2` → `2.0.0.2;`), and a
 * quoted value converts only at run time (`address="2.2"` stays `2.2`). The
 * slot is `schemaType`'s.
 *
 * Grounded on CHR 7.24.5 and 7.23.8 over REST and native API, identical on
 * both builds; the raw matrix is in `test/fixtures/explain/live-types.*.json`
 * and its reading is pinned in `test/unit/explain-live-types.test.ts`.
 *
 * ## schemaType: the argument's declaration, normalized
 *
 * One `syntax` probe per distinct (command, argument) pair, at the ARGUMENT
 * path only (a command path hangs REST on 7.12.2 and 7.20.8; see
 * `explain-live-facets.ts`). The argument name is resolved against the
 * command's live `child` names, unique prefixes included, as RouterOS does.
 * The rows are a small grammar (`[!]Range`, `Address[%Interface][@VRF]`); the
 * projection maps each leaf to {@link SCHEMA_VALUE_TYPES} and abstains when a
 * leaf has no mapping (`see documentation`) or the declaration is blank, as
 * every flag and boolean is. A listed word set is `enum` even when the words
 * are the current configuration names (`ether1 | lo`): the device prints both
 * the same way, so the live projection never emits `name`. Keyword descriptions (`tcp` → `transmission
 * control protocol`) are help for a parent keyword, not leaves.
 */
import { isIP } from "node:net";
import { pathTokens } from "./core/inspect.ts";
import { routerOsStringLiteral } from "./core/routeros-string.ts";
import type { ObservedValueType, SchemaValueType } from "./explain/values.ts";
import type {
	ExplainSchemaTypeFact,
	ExplainSpanRange,
	ExplainStatement,
	ExplainSubcommand,
	ExplainSyntaxRow,
	ExplainValueOccurrence,
	ExplainValueTypeFact,
} from "./explain.ts";
import type { LiveProbeContext } from "./explain-live.ts";

/** Hard bounds. Work past them is skipped with a reason, never truncated silently. */
export const EXPLAIN_TYPE_LIMITS = {
	/** Literals per `:parse` batch. */
	literals: 256,
	/** Argument-level `syntax` probes per call. */
	syntaxProbes: 32,
} as const;

/**
 * The bytes a probe literal may hold. No quote, `$`, bracket, brace, paren,
 * `;`, `=` or space, so the literal cannot leave its slot; a leading `/` or
 * `:` would read as a path or a command.
 */
const PROBE_LITERAL = /^-?[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

type Reading = ExplainStatement | ExplainSubcommand;
export type TypeProbeContext = "operand" | "member";
type Context = TypeProbeContext;

export async function collectValueTypes(ctx: LiveProbeContext): Promise<void> {
	const occurrences = ctx.data.values.occurrences;
	if (occurrences.length === 0) return;
	const batches: Record<Context, ExplainValueOccurrence[]> = {
		operand: [],
		member: [],
	};
	const statementIds: Record<Context, Set<string>> = {
		operand: new Set(),
		member: new Set(),
	};
	const named: { occurrence: ExplainValueOccurrence; reading: Reading }[] = [];
	for (const occurrence of occurrences) {
		const reading = readingOf(ctx, occurrence.tokenSpan);
		if (reading?.kind !== "command" || reading.resolution !== "resolved")
			continue;
		const directive = reading.command.path === "/";
		if (directive) {
			const context = observedContext(ctx, occurrence);
			if (context) {
				batches[context].push(occurrence);
				statementIds[context].add(
					"owner" in reading ? reading.owner : reading.id,
				);
			}
		} else if (
			occurrence.kind === "attribute" &&
			occurrence.name !== undefined &&
			"id" in reading
		)
			named.push({ occurrence, reading });
	}
	for (const context of ["operand", "member"] as const)
		await observe(ctx, context, batches[context], [...statementIds[context]]);
	await declare(ctx, named);
}

// ---------------------------------------------------------------- observed

function observedContext(
	ctx: LiveProbeContext,
	occurrence: ExplainValueOccurrence,
): Context | undefined {
	if (occurrence.kind !== "positional" && occurrence.kind !== "element")
		return undefined;
	// The span keeps a quoted value's quotes, so the byte set refuses it too.
	const literal = ctx.analyzed.slice(
		occurrence.span.start,
		occurrence.span.end,
	);
	if (!PROBE_LITERAL.test(literal)) return undefined;
	return occurrence.kind === "element" ? "member" : "operand";
}

async function observe(
	ctx: LiveProbeContext,
	context: Context,
	batch: ExplainValueOccurrence[],
	statementIds: string[],
): Promise<void> {
	if (batch.length === 0) return;
	const literals = batch.map((o) =>
		ctx.analyzed.slice(o.span.start, o.span.end),
	);
	const script = typeProbeScript(context, literals);
	const ev = ctx.evidence(":parse", {
		facet: "types",
		basis: "derived",
		statementIds,
		inputSha256: ctx.sha256(script),
		normalization: "original-utf8",
	});
	if (batch.length > EXPLAIN_TYPE_LIMITS.literals) {
		ev.outcome = "skipped";
		ev.reason = `${batch.length} ${context} literals exceed the ${EXPLAIN_TYPE_LIMITS.literals}-literal type budget.`;
		return;
	}
	const result = await ctx.run(ev, () =>
		ctx.backend.execute({
			path: "",
			command: "",
			script: `:put [:parse ${routerOsStringLiteral(script)}]`,
		}),
	);
	if (!result) return;
	const output = typeof result.ret === "string" ? result.ret.trim() : "";
	if (output === "") {
		ev.outcome = "empty";
		return;
	}
	const rendered = splitRenderings(output, batch.length);
	if (!rendered) {
		ev.outcome = "invalid-response";
		ev.reason = output.startsWith("(evl ")
			? "The type probe's parse output does not split into one rendering per literal."
			: `The device rejected the ${context} type probe: ${output}`;
		return;
	}
	batch.forEach((occurrence, i) => {
		const fact = observedTypeOf(literals[i] ?? "", rendered[i] ?? "", ev.id);
		if (fact) occurrence.facts.observedType = fact;
	});
}

/** The probe text before quoting: one `:local` per literal, `;`-joined. */
export function typeProbeScript(
	context: Context,
	literals: readonly string[],
): string {
	return literals
		.map((literal, i) =>
			context === "member"
				? `:local v${i} {${literal}}`
				: `:local v${i} ${literal}`,
		)
		.join(";");
}

/**
 * Each probe statement renders `(evl /localname=$vN;value=<rendering>)`, joined
 * by `;`. The markers are centrs's own, and a probe literal holds no `(`, so a
 * marker cannot appear inside a rendering.
 */
export function splitRenderings(
	output: string,
	count: number,
): string[] | undefined {
	const out: string[] = [];
	let at = 0;
	for (let i = 0; i < count; i++) {
		const marker = `(evl /localname=$v${i};value=`;
		if (!output.startsWith(marker, at)) return undefined;
		const start = at + marker.length;
		const next = i + 1 < count ? `);(evl /localname=$v${i + 1};value=` : ")";
		const end = i + 1 < count ? output.indexOf(next, start) : output.length - 1;
		if (end < start || (i + 1 === count && !output.endsWith(")")))
			return undefined;
		out.push(output.slice(start, end));
		at = end + 2;
	}
	return out;
}

const TIME_RENDERING = /^(?:\d+w)?(?:\d+d)?\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/** The type a changed rendering names, or nothing. */
export function observedTypeOf(
	literal: string,
	rendered: string,
	ev: string,
): ExplainValueTypeFact | undefined {
	if (rendered === literal) return undefined;
	const value = renderedType(rendered);
	return value ? { value, rendered, ev } : undefined;
}

function renderedType(rendered: string): ObservedValueType | undefined {
	if (/^-?\d+$/.test(rendered)) return "num";
	if (rendered === "true" || rendered === "false") return "bool";
	const slash = rendered.indexOf("/");
	const [address, length] =
		slash === -1
			? [rendered, undefined]
			: [rendered.slice(0, slash), rendered.slice(slash + 1)];
	if (length !== undefined && !/^\d+$/.test(length)) return undefined;
	const family = isIP(address);
	if (family === 4) return length === undefined ? "ip" : "ip-prefix";
	if (family === 6) return length === undefined ? "ip6" : "ip6-prefix";
	if (length === undefined && TIME_RENDERING.test(rendered)) return "time";
	return undefined;
}

// ---------------------------------------------------------------- declared

async function declare(
	ctx: LiveProbeContext,
	named: { occurrence: ExplainValueOccurrence; reading: Reading }[],
): Promise<void> {
	const probes = new Map<
		string,
		{
			tokens: string[];
			statementIds: Set<string>;
			occurrences: ExplainValueOccurrence[];
		}
	>();
	for (const { occurrence, reading } of named) {
		const statementId = (reading as ExplainStatement).id;
		const discovered = ctx.data.live?.arguments.find((entry) =>
			entry.statementIds.includes(statementId),
		);
		if (!discovered || reading.kind !== "command") continue;
		const name = resolveArgumentName(occurrence.name ?? "", discovered.names);
		if (!name) continue;
		const tokens = [...pathTokens(discovered.path), name];
		const key = tokens.join(",");
		const probe = probes.get(key) ?? {
			tokens,
			statementIds: new Set<string>(),
			occurrences: [],
		};
		probe.statementIds.add(statementId);
		probe.occurrences.push(occurrence);
		probes.set(key, probe);
	}
	let sent = 0;
	for (const probe of probes.values()) {
		const ev = ctx.evidence("syntax", {
			facet: "types",
			basis: "derived",
			path: `/${probe.tokens.join("/")}`,
			statementIds: [...probe.statementIds],
		});
		if (++sent > EXPLAIN_TYPE_LIMITS.syntaxProbes) {
			ev.outcome = "skipped";
			ev.reason = `Argument-type budget of ${EXPLAIN_TYPE_LIMITS.syntaxProbes} syntax probes exhausted.`;
			continue;
		}
		// Argument paths only: a command path hangs REST on 7.12.2 and 7.20.8.
		const rows = await ctx.run(ev, () =>
			ctx.backend.inspect("syntax", probe.tokens.join(",")),
		);
		if (rows === undefined) continue;
		if (
			!Array.isArray(rows) ||
			rows.some((row) => row === null || typeof row !== "object")
		) {
			ev.outcome = "invalid-response";
			ev.reason = "Syntax response is not an array of rows.";
			continue;
		}
		if (rows.length === 0) {
			ev.outcome = "empty";
			continue;
		}
		const fact = schemaTypeOf(
			(rows as Record<string, unknown>[]).map((row) => ({
				symbol: String(row["symbol"] ?? ""),
				kind: String(row["symbol-type"] ?? ""),
				text: String(row["text"] ?? ""),
				depth: Number(row["nested"] ?? 0),
			})),
			ev.id,
		);
		if (fact)
			for (const occurrence of probe.occurrences)
				occurrence.facts.schemaType = fact;
	}
}

/** An exact name, else a unique prefix, as RouterOS resolves an argument. */
export function resolveArgumentName(
	name: string,
	names: readonly string[],
): string | undefined {
	if (names.includes(name)) return name;
	const matches = names.filter((candidate) => candidate.startsWith(name));
	return name !== "" && matches.length === 1 ? matches[0] : undefined;
}

/** Leaf text annotations the device appends, in parentheses. */
const ANNOTATIONS: Record<string, SchemaValueType> = {
	"integer number": "num",
	"decimal number": "num",
	"time interval": "time",
	"IP address": "ip",
	"IP prefix": "ip-prefix",
	"IP address range": "ip-range",
	"IPv6 prefix": "ip6-prefix",
	"MAC address": "mac",
};

/** Whole-leaf texts the device uses without an annotation. */
const LEAF_TEXTS: Record<string, SchemaValueType> = {
	"string value": "str",
	"hexadecimal string value": "str",
	script: "str",
	filename: "str",
	"integer value": "num",
	"time interval": "time",
	"IPv4 address": "ip",
	"IPv6 address": "ip6",
	"A.B.C.D": "ip",
};

const REPETITION = /\[,[A-Za-z]|\(max \d+ times\)/;
const KEYWORD = /^[A-Za-z0-9][\w.-]*$/;

/**
 * Normalize argument `syntax` rows, or abstain. Exported for the fixture
 * replay and the crawl that grounded the tables above.
 */
export function schemaTypeOf(
	rows: readonly ExplainSyntaxRow[],
	ev: string,
): ExplainSchemaTypeFact | undefined {
	const kept = rows.filter(
		(row) =>
			!(
				row.kind === "explanation" &&
				row.depth > 0 &&
				/^[a-z0-9]/.test(row.symbol)
			),
	);
	const root = kept[0];
	if (!root || kept.every((row) => row.text.trim() === "")) return undefined;
	const values: SchemaValueType[] = [];
	for (const [i, row] of kept.entries()) {
		const next = kept[i + 1];
		// A blank leaf is a placeholder (`"" | string value`); it says nothing.
		if (row.text.trim() === "") continue;
		if (next !== undefined && next.depth > row.depth) continue;
		const terms = leafTypes(row.text);
		if (!terms) return undefined;
		for (const term of terms) if (!values.includes(term)) values.push(term);
	}
	if (values.length === 0) return undefined;
	return {
		values,
		...(kept.some((row) => REPETITION.test(row.text))
			? { list: true as const }
			: {}),
		declared: root.text.trim() === "" ? root.symbol : root.text.trim(),
		ev,
	};
}

function leafTypes(raw: string): SchemaValueType[] | undefined {
	let text = raw.replace(/\s+/g, " ").trim();
	const terms: SchemaValueType[] = [];
	for (;;) {
		const annotation = /\s*\(([^()]*)\)$/.exec(text);
		if (!annotation) break;
		text = text.slice(0, annotation.index).trim();
		const label = annotation[1] ?? "";
		if (/^max \d+ times$/.test(label)) continue;
		const term = ANNOTATIONS[label];
		if (!term) return undefined;
		terms.push(term);
	}
	if (terms.length > 0) return terms;
	const whole =
		LEAF_TEXTS[text] ??
		LEAF_TEXTS[text.replace(/, (?:min|max) length \d+/g, "")];
	if (whole) return [whole];
	if (/^-?[0-9A-F]+\.\.[0-9A-F]+$/.test(text)) return ["num"];
	const alternatives = text
		.replace(/\[,[A-Za-z]\w*\*\]$/, "")
		.split("|")
		.map((part) => part.trim())
		.filter((part) => part !== "");
	// A listed word set is `enum` whether it holds keywords or the current
	// configuration names (`ether1 | lo`); `...` only marks a long list cut
	// short, and keyword lists are cut too (`ftp | h323 | … | ...`).
	const open = alternatives.at(-1) === "...";
	const words = open ? alternatives.slice(0, -1) : alternatives;
	if (!words.every((word) => KEYWORD.test(word))) return undefined;
	return words.length > 0 || open ? ["enum"] : undefined;
}

// ---------------------------------------------------------------- readings

/** The innermost statement or `[…]` substitution containing the span. */
function readingOf(
	ctx: LiveProbeContext,
	span: ExplainSpanRange,
): Reading | undefined {
	let found: Reading | undefined;
	const { statements, subcommands } = ctx.data.structure;
	for (const reading of [...statements, ...subcommands]) {
		if (reading.span.start > span.start || reading.span.end < span.end)
			continue;
		if (
			!found ||
			reading.span.end - reading.span.start < found.span.end - found.span.start
		)
			found = reading;
	}
	return found;
}
