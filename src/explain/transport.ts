/**
 * Fail-closed offline transport classification for `explain` (#202c-2).
 *
 * RouterOS REST has a broad mechanical convention (CRUD verbs plus command
 * POSTs), but `explain` emits a runnable request only for the nine Q8 shapes
 * exercised successfully on CHR 7.23.2 and 7.24rc2. The table below is that
 * closed set. A verb or operand merely looking REST-shaped never widens it.
 */

import type { ArgumentKind } from "./args.ts";

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

interface LocatedArgumentToken {
	kind: ArgumentKind;
	name?: string;
	value?: string;
	text: string;
}

type LocatedArguments =
	| {
			read: true;
			tokens: readonly LocatedArgumentToken[];
			queries: readonly string[];
			positional: readonly string[];
	  }
	| { read: false; why: string };

export interface ExplainTransportInput {
	command: {
		path: string;
		verb: string;
		args?: Record<string, string>;
	};
	arguments: LocatedArguments;
	/** The statement exactly as written, for the execute invocation. */
	source: string;
}

export interface ExplainTransportOptions {
	renderCurl?: boolean;
	evidenceId: string;
}

type EndpointShape = "menu" | "id" | "command";
type BodyShape = "none" | "attributes";

interface TestedRestRule {
	method: ExplainRestMethod;
	endpoint: EndpointShape;
	body: BodyShape;
	requiresBody?: boolean;
}

/**
 * The non-print Q8 rules. `print` has three separately exercised shapes and is
 * handled below: bare GET, `.proplist` POST, and `.query` POST.
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
	run: {
		method: "POST",
		endpoint: "command",
		body: "attributes",
		requiresBody: true,
	},
};

const ROUTEROS_ID = /^\*[0-9A-F]+$/i;
const QUERY_NAME = /^[A-Za-z][A-Za-z0-9._-]*(?:=.*)?$/;
const QUERY_COMPARISON = /^[<>][A-Za-z][A-Za-z0-9._-]*=.*$/;

function restPath(path: string): string {
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
	verb: string,
	rule: TestedRestRule,
	id: string | undefined,
): string {
	const base = restPath(path);
	if (rule.endpoint === "id") return `${base}/${id}`;
	if (rule.endpoint === "command") return `${base}/${verb}`;
	return base;
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
	if (rest.body !== undefined && Object.keys(rest.body).length > 0) {
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

function literalId(arguments_: LocatedArguments): string | undefined {
	if (!arguments_.read || arguments_.tokens.length === 0) return undefined;
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

function isRestQueryWord(word: string): boolean {
	return QUERY_NAME.test(word) || QUERY_COMPARISON.test(word);
}

function printRequest(
	input: ExplainTransportInput,
): { rest: ExplainRestRequest; basis: string } | string {
	const arguments_ = input.arguments;
	if (!arguments_.read) return arguments_.why;
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
		const word = token.text;
		if (token.value === undefined || !isRestQueryWord(word))
			return `where expression ${JSON.stringify(token.text)} has no tested .query translation`;
		query.push(word);
	}

	if (where && query.length === 0)
		return "print where has no query expression to send";
	if (where && proplist !== undefined)
		return "combined print projection and query were not runtime-exercised";
	if (proplist !== undefined && proplist.length === 0)
		return "the tested print projection requires at least one property";
	if (query.some((word) => !isRestQueryWord(word)))
		return "a query word has no tested .query translation";

	const base = restPath(input.command.path);
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

	if (lower === "print") {
		const planned = printRequest(input);
		return typeof planned === "string"
			? unknown(planned, options.evidenceId)
			: apiCandidate(planned.rest, planned.basis, options);
	}

	const rule = TESTED_REST_RULES[lower];
	if (rule === undefined)
		return unknown(
			`no runtime-exercised REST mapping exists for verb ${JSON.stringify(verb)}`,
			options.evidenceId,
		);

	const id = rule.endpoint === "id" ? literalId(input.arguments) : undefined;
	if (rule.endpoint === "id" && id === undefined) {
		const setBoundary =
			lower === "set" && input.arguments.positional.length === 0
				? "offline cannot distinguish a singleton menu from an id-bearing table"
				: `the tested ${lower} mapping requires exactly one literal RouterOS .id`;
		return unknown(setBoundary, options.evidenceId);
	}

	if (
		(rule.endpoint !== "id" && input.arguments.positional.length > 0) ||
		input.arguments.queries.length > 0 ||
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
		path: endpointOf(path, lower, rule, id),
		...(body === undefined ? {} : { body }),
	};
	return apiCandidate(
		rest,
		`Q8 tested ${lower} as ${rule.method} on CHR 7.23.2 and 7.24rc2`,
		options,
	);
}
