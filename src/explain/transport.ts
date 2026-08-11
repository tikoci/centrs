/**
 * Fail-closed offline transport classification for `explain` (#202c-2).
 *
 * RouterOS REST has a broad mechanical convention (CRUD verbs plus command
 * POSTs), and `explain` emits a runnable request only where the Q8 probe
 * exercised that convention on CHR 7.23.2 and 7.24rc2
 * (`test/fixtures/explain/transport-rest-q8.v*.json`, promoted in #186).
 * The rules below are that evidence.
 * A verb or operand merely looking REST-shaped never widens them.
 *
 * ## The four CRUD rules are literal; the action rule is a family
 *
 * `add`/`get`/`set`/`remove` were each exercised as themselves, so they are a
 * closed table keyed on the verb. The fifth row was exercised as
 * `/ip/dns/cache flush` → `POST /rest/ip/dns/cache/flush` with body `{}`, and
 * the probe recorded it as the RULE `run(action) → POST /rest/<path>/<command>`
 * — a statement about how the REST adapter builds a URL for a menu action, not
 * about the one verb that demonstrated it (maintainer decision, #241 review:
 * most non-`get`/`set`/`print` operations are that POST, `monitor` included).
 * So any verb outside the four CRUD rules, `print`, and `find` rides it.
 *
 * That rule deliberately does NOT claim the verb exists. Whether a menu has a
 * `run` is a schema question, and offline has no schema: the `catalog.ts`
 * command rows confirm a verb where they carry one, but "a MISS says nothing"
 * is that table's own contract, so a miss strengthens no refusal. Existence is
 * the phase-2 `/console/inspect` probe's answer, not this pass's.
 *
 * What DOES fail closed on the action rule is a positional operand: RouterOS
 * names it from per-menu schema (`/file set 0` → `numbers=0`), decision 3 keeps
 * no offline schema snapshot, and a POST body that omits the target would run
 * against the wrong rows. `/ip/address enable *A` is therefore `unknown`, and
 * the reason names the live probe that would lift it.
 */

import type { ExplainArguments } from "../explain.ts";
import { lookupPath } from "./catalog.ts";

export type ExplainTransportClassification =
	| "api-candidate"
	| "execute"
	| "unknown";

export type ExplainRestMethod = "GET" | "PUT" | "PATCH" | "DELETE" | "POST";

export interface ExplainRestRequest {
	method: ExplainRestMethod;
	path: string;
	body?: Record<string, unknown>;
}

interface ExplainTransportBase {
	classification: ExplainTransportClassification;
	/** Why this route was selected or refused. */
	basis: string;
	/** Evidence id assigned by the composing explain pass. */
	ev: string;
}

export interface ExplainApiCandidateTransport extends ExplainTransportBase {
	classification: "api-candidate";
	rest: ExplainRestRequest;
	/** Equivalent structured centrs invocation, using an offline target placeholder. */
	centrs: string;
	/** Present only when the caller requested curl rendering. */
	curl?: string;
}

export interface ExplainExecuteTransport extends ExplainTransportBase {
	classification: "execute";
	/** Equivalent raw-CLI centrs invocation, using an offline target placeholder. */
	centrs: string;
	rest?: undefined;
	curl?: undefined;
}

export interface ExplainUnknownTransport extends ExplainTransportBase {
	classification: "unknown";
	rest?: undefined;
	centrs?: undefined;
	curl?: undefined;
}

export type ExplainTransport =
	| ExplainApiCandidateTransport
	| ExplainExecuteTransport
	| ExplainUnknownTransport;

/** The reading this pass consumes, once the lexer has decided every token. */
type ReadArguments = Extract<ExplainArguments, { read: true }>;

export interface ExplainTransportInput {
	command: {
		path: string;
		verb: string;
		args?: Record<string, string>;
	};
	/**
	 * The envelope's own argument reading, imported rather than restated so the
	 * transport contract cannot drift from what `src/explain.ts` publishes.
	 */
	arguments: ExplainArguments;
	/** The statement exactly as written, for the execute invocation. */
	source: string;
}

export interface ExplainTransportOptions {
	renderCurl?: boolean;
	evidenceId: string;
}

type EndpointShape = "menu" | "id";
type BodyShape = "none" | "attributes";

interface TestedRestRule {
	method: ExplainRestMethod;
	endpoint: EndpointShape;
	body: BodyShape;
	requiresBody?: boolean;
}

/**
 * The Q8 rules keyed on a literal verb. `print` has three separately exercised
 * shapes and is handled below (bare GET, `.proplist` POST, `.query` POST), and
 * every other verb rides the action rule.
 */
const TESTED_REST_RULES: Readonly<Record<string, TestedRestRule>> = {
	add: {
		method: "PUT",
		endpoint: "menu",
		body: "attributes",
		requiresBody: true,
	},
	get: { method: "GET", endpoint: "id", body: "none" },
	set: {
		method: "PATCH",
		endpoint: "id",
		body: "attributes",
		requiresBody: true,
	},
	remove: { method: "DELETE", endpoint: "id", body: "none" },
};

const ROUTEROS_ID = /^\*[0-9A-F]+$/i;
/**
 * A `.query` word's property name. Q8 exercised exactly one spelling —
 * `interface=ether1` — so this matches the NAME half and the value is required
 * separately. A bare property, an empty value, an infix comparison
 * (`address>1.1.1.1`), and a second `where` all fail that pair and fail closed;
 * REST's own `<name=value` / `>name=value` comparison words are not a `where`
 * spelling any device exercised here.
 */
const QUERY_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;

function restPath(path: string): string {
	// A single trailing slash, never a run: `path` is a resolved menu path from
	// `pathresolve.ts`, whose segments are non-empty by construction, so `//`
	// cannot reach here and one strip is total.
	return `/rest${path === "/" ? "" : path.replace(/\/$/, "")}`;
}

function shellQuote(value: string): string {
	// End the single-quoted run, emit the apostrophe from a double-quoted run,
	// then reopen it. This is portable POSIX shell syntax and keeps every other
	// byte literal.
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function bodyOf(
	rule: TestedRestRule,
	args: Record<string, string>,
): Record<string, unknown> | undefined {
	if (rule.body === "none" || Object.keys(args).length === 0) return undefined;
	return { ...args };
}

function endpointOf(
	path: string,
	rule: TestedRestRule,
	id: string | undefined,
): string {
	const base = restPath(path);
	return rule.endpoint === "id" ? `${base}/${id}` : base;
}

function renderCentrsApi(rest: ExplainRestRequest): string {
	const printFacet =
		rest.method === "POST" &&
		rest.path.endsWith("/print") &&
		(rest.body?.[".proplist"] !== undefined ||
			rest.body?.[".query"] !== undefined);
	const renderedPath = printFacet
		? rest.path.slice(0, -"/print".length)
		: rest.path;
	const endpoint = renderedPath.replace(/^\/rest/, "") || "/";
	const parts = ["centrs", "api", shellQuote("<router>"), shellQuote(endpoint)];
	// `centrs api` models print as GET even when query/projection makes its REST
	// adapter send POST `/print`; giving the user `-X POST` would select `run` and
	// silently drop the print facets.
	if (rest.method !== "GET" && !printFacet) parts.push("-X", rest.method);
	const body = rest.body ?? {};
	const proplist = body[".proplist"];
	if (Array.isArray(proplist))
		parts.push("--proplist", shellQuote(proplist.join(",")));
	const query = body[".query"];
	if (Array.isArray(query)) {
		for (const word of query)
			if (typeof word === "string") parts.push("--raw-query", shellQuote(word));
	}
	for (const [name, value] of Object.entries(body)) {
		if (name === ".proplist" || name === ".query") continue;
		// Keep source order: the argument lexer builds `args` in token order, which
		// makes the suggested command read like the input while remaining stable.
		parts.push(
			"-f",
			shellQuote(
				`${name}=${typeof value === "string" ? value : JSON.stringify(value)}`,
			),
		);
	}
	return parts.join(" ");
}

function renderCurl(rest: ExplainRestRequest): string {
	const parts = [
		"curl",
		"--user",
		shellQuote("<username>:<password>"),
		"--request",
		rest.method,
	];
	// An EMPTY body still ships as `{}`: that is the byte-for-byte request the Q8
	// action probe sent (`POST /rest/ip/dns/cache/flush {}` → 200), and a POST
	// with no entity is a different request.
	if (rest.body !== undefined) {
		parts.push(
			"--header",
			shellQuote("Content-Type: application/json"),
			"--data",
			shellQuote(JSON.stringify(rest.body)),
		);
	}
	parts.push(shellQuote(`https://<router>${rest.path}`));
	return parts.join(" ");
}

function apiCandidate(
	rest: ExplainRestRequest,
	basis: string,
	options: ExplainTransportOptions,
): ExplainApiCandidateTransport {
	return {
		classification: "api-candidate",
		basis,
		rest,
		centrs: renderCentrsApi(rest),
		...(options.renderCurl ? { curl: renderCurl(rest) } : {}),
		ev: options.evidenceId,
	};
}

function execute(
	source: string,
	basis: string,
	evidenceId: string,
): ExplainExecuteTransport {
	return {
		classification: "execute",
		basis,
		centrs: `centrs execute ${shellQuote("<router>")} ${shellQuote(source)}`,
		ev: evidenceId,
	};
}

function unknown(basis: string, evidenceId: string): ExplainUnknownTransport {
	return { classification: "unknown", basis, ev: evidenceId };
}

/**
 * The one literal `.id` an id-bearing rule needs, or nothing.
 *
 * Only `tokens[0]` is examined, and only when it is the sole positional. The
 * rejection is deliberately two-stage: `get *A comment=x` gets an id here and is
 * then refused by the `body === "none"` guard in the caller, because "there is
 * an id" and "the operands fit the tested shape" are separate questions and
 * folding them would hide which one failed from the basis string.
 */
function literalId(arguments_: ReadArguments): string | undefined {
	if (arguments_.tokens.length === 0) return undefined;
	const [first] = arguments_.tokens;
	if (
		arguments_.positional.length !== 1 ||
		first?.kind !== "positional" ||
		first.value === undefined ||
		!ROUTEROS_ID.test(first.value)
	)
		return undefined;
	return first.value;
}

function printRequest(
	arguments_: ReadArguments,
	path: string,
): { rest: ExplainRestRequest; basis: string } | string {
	if (arguments_.queries.length > 0)
		return "only the tested print where shape can produce a REST .query";
	const query: string[] = [];
	let proplist: string[] | undefined;
	let where = false;

	for (const token of arguments_.tokens) {
		if (token.kind === "query") continue;
		if (token.kind === "attribute" && token.name === "proplist") {
			if (where)
				return "combined print projection and query were not runtime-exercised";
			if (token.value === undefined) return "the proplist value is not literal";
			proplist = token.value
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean);
			continue;
		}
		if (token.kind === "positional" && token.value === "where" && !where) {
			where = true;
			continue;
		}
		if (!where)
			return `print operand ${JSON.stringify(token.text)} is outside the tested no-argument/proplist/query rules`;
		if (
			token.kind !== "attribute" ||
			token.name === undefined ||
			!QUERY_NAME.test(token.name) ||
			token.value === undefined ||
			token.value === ""
		)
			return `where expression ${JSON.stringify(token.text)} has no tested .query translation`;
		// The DECODED value, never `text`: `comment="a b"` must reach the device as
		// `comment=a b`, and shipping the quote bytes would filter on a value no
		// row holds.
		query.push(`${token.name}=${token.value}`);
	}

	if (where && query.length === 0)
		return "print where has no query expression to send";
	if (where && proplist !== undefined)
		return "combined print projection and query were not runtime-exercised";
	if (proplist !== undefined && proplist.length === 0)
		return "the tested print projection requires at least one property";

	const base = restPath(path);
	if (query.length === 0 && proplist === undefined)
		return {
			rest: { method: "GET", path: base },
			basis: "Q8 tested bare print as GET on CHR 7.23.2 and 7.24rc2",
		};
	const body: Record<string, unknown> = {};
	if (query.length > 0) body[".query"] = query;
	if (proplist !== undefined) body[".proplist"] = proplist;
	return {
		rest: { method: "POST", path: `${base}/print`, body },
		basis:
			"Q8 tested print projection/query as POST to the print endpoint on CHR 7.23.2 and 7.24rc2",
	};
}

/**
 * The Q8 action rule: a menu action POSTs to its own command endpoint.
 *
 * `find` is excluded and not because it is untested — it is a SELECTOR. A bare
 * `find` yields ids for another statement to consume, there is no
 * `/rest/<path>/find` for it to become, and `[find …]` already left through the
 * execute branch above.
 */
function actionRequest(
	input: ExplainTransportInput,
	lower: string,
	arguments_: ReadArguments,
	options: ExplainTransportOptions,
): ExplainTransport {
	// The endpoint carries the verb AS WRITTEN. RouterOS paths are
	// case-sensitive, so the normalized spelling is for LOOKUPS only — building
	// `/rest/ip/address/tostring` out of `toString` would be a different URL.
	const { path, verb, args = {} } = input.command;
	if (lower === "find")
		return unknown(
			"find selects rows for another statement to consume and has no REST endpoint of its own",
			options.evidenceId,
		);
	if (arguments_.positional.length > 0)
		return unknown(
			`offline cannot name the operand ${JSON.stringify(arguments_.positional[0])} the tested action POST would carry — RouterOS names it from per-menu schema, which is live evidence`,
			options.evidenceId,
		);
	if (arguments_.queries.length > 0)
		return unknown(
			"the tested action POST carries attributes, and a ?query has no place in its body",
			options.evidenceId,
		);

	// A catalog hit is decisive about what the segment IS; a miss says nothing
	// (`catalog.ts`), so it narrows the basis rather than the classification.
	const named =
		lookupPath([...path.split("/").filter(Boolean), lower])?.kind === "command";
	return apiCandidate(
		{
			method: "POST",
			path: `${restPath(path)}/${verb}`,
			// `{}`, not omitted: the Q8 action probe sent an empty object.
			body: { ...args },
		},
		`Q8 tested a menu action as POST to its command endpoint on CHR 7.23.2 and 7.24rc2; ${
			named
				? `the CLI Reference catalog names ${path}/${verb} a command`
				: `no offline source can confirm ${JSON.stringify(verb)} is a command under ${path}`
		}`,
		options,
	);
}

/** Classify one resolved statement and optionally render its REST curl. */
export function classifyExplainTransport(
	input: ExplainTransportInput,
	options: ExplainTransportOptions,
): ExplainTransport {
	const { path, verb, args = {} } = input.command;
	const lower = verb.toLowerCase();

	// Root scripting directives have no RouterOS REST path. They always ride the
	// raw execute surface, regardless of whether their operands are literal.
	if (path === "/")
		return execute(
			input.source,
			"a RouterOS scripting directive has no structured REST endpoint",
			options.evidenceId,
		);

	// Once an operand requires RouterOS evaluation, the exact CLI statement is
	// the only semantics-preserving rendering. This check deliberately precedes
	// the REST verb table: selector actions such as `enable [find ...]` are
	// execute-shaped even though literal `enable 0` has no tested REST rule.
	if (!input.arguments.read)
		return execute(
			input.source,
			`the argument list requires RouterOS evaluation (${input.arguments.why})`,
			options.evidenceId,
		);

	const arguments_ = input.arguments;

	if (lower === "print") {
		const planned = printRequest(arguments_, path);
		return typeof planned === "string"
			? unknown(planned, options.evidenceId)
			: apiCandidate(planned.rest, planned.basis, options);
	}

	// `Object.hasOwn`, not a truthiness test: a plain object literal inherits
	// `Object.prototype`, so `TESTED_REST_RULES["constructor"]` is a function
	// that passes an `=== undefined` guard and then reads `undefined` out of
	// every shape field. The table is only closed when the lookup is.
	const rule = Object.hasOwn(TESTED_REST_RULES, lower)
		? TESTED_REST_RULES[lower]
		: undefined;
	if (rule === undefined)
		return actionRequest(input, lower, arguments_, options);

	const id = rule.endpoint === "id" ? literalId(arguments_) : undefined;
	if (rule.endpoint === "id" && id === undefined) {
		const setBoundary =
			lower === "set" && arguments_.positional.length === 0
				? "offline cannot distinguish a singleton menu from an id-bearing table"
				: `the tested ${lower} mapping requires exactly one literal RouterOS .id`;
		return unknown(setBoundary, options.evidenceId);
	}

	if (
		(rule.endpoint !== "id" && arguments_.positional.length > 0) ||
		arguments_.queries.length > 0 ||
		(rule.body === "none" && Object.keys(args).length > 0) ||
		(rule.requiresBody === true && Object.keys(args).length === 0)
	)
		return unknown(
			`the operands are outside the tested ${lower} REST shape`,
			options.evidenceId,
		);

	const body = bodyOf(rule, args);
	const rest: ExplainRestRequest = {
		method: rule.method,
		path: endpointOf(path, rule, id),
		...(body === undefined ? {} : { body }),
	};
	return apiCandidate(
		rest,
		`Q8 tested ${lower} as ${rule.method} on CHR 7.23.2 and 7.24rc2`,
		options,
	);
}
