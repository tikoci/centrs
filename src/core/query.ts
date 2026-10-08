/**
 * `--query` predicates: the inside of a RouterOS `print where …`, compiled to
 * the API query stack (native `?` words, REST `.query` — the same words minus
 * the `?`, `commands/api/AGENTS.md`).
 *
 * One grammar serves `retrieve --query`, `api --query` and, later, `--until`
 * (#397, #364). It reads like `where`: `interface=ether1 and !disabled`,
 * `(type=ether or type=vlan) and mtu>=1500`. The device evaluates the compiled
 * stack, so comparisons keep RouterOS's per-property typing.
 *
 * Words are emitted in postfix order; `#!`, `#&`, `#|` pop their operands, and
 * whatever remains is AND-ed by RouterOS. Mapping, grounded by the CHR
 * `find where` vs `.query` differential (`test/integration/retrieve-query.test.ts`):
 *
 * | where          | words                         |
 * | -------------- | ----------------------------- |
 * | `a=v`          | `a=v`                         |
 * | `a!=v`         | `a=v` `#!`                    |
 * | `a<v`          | `<a=v` `-a` `#|`              |
 * | `a>v`          | `>a=v`                        |
 * | `a<=v`         | `>a=v` `#!`                   |
 * | `a>=v`         | `<a=v` `-a` `#|` `#!`         |
 * | bare `a`       | `a=yes` for a boolean, else `a` (is set) |
 * | `!x`           | x `#!`                        |
 * | `x and y`      | x y `#&`                      |
 * | `x or y`       | x y `#|`                      |
 *
 * Ordering follows `where`, where a row without the property is smaller than
 * any value: `timeout<1d` includes static address-list entries, `timeout>1h`
 * does not. API `<`/`>` skip such rows, hence the `-a` (absent) word.
 *
 * A bare name means what it means after `where`, which depends on the
 * property: `where disabled` is `disabled=yes`, `where comment` is "comment is
 * set" (an empty comment is stored as absent). The caller asks the device
 * which names are booleans (`inspectWhereBooleans`) before emitting.
 *
 * Refused rather than approximated: `~` (regex) and `in` (prefix membership)
 * have no API query word; `$`/`[`/`{` values need a script evaluator;
 * `!a=v` is `(!a)=v` to RouterOS, which matches by accident, so it must be
 * written `!(a=v)` or `a!=v`; `not` is not a RouterOS operator; and
 * space-separated conditions must be joined with `and`/`or`.
 *
 * The device decides comparisons with the API's per-property typing, which is
 * not always the CLI's: `where dst-port=80` reads `80` as a number and matches
 * nothing, while the query matches the `"80"` that `retrieve` shows; ordering
 * on a text property (`dst-port`, address-list `address`) is text order.
 */

import { CentrsError } from "../errors.ts";

export type QueryComparison = "=" | "!=" | "<" | ">" | "<=" | ">=";

export type QueryNode =
	| { kind: "compare"; name: string; op: QueryComparison; value: string }
	| { kind: "truthy"; name: string }
	| { kind: "not"; operand: QueryNode }
	| { kind: "and" | "or"; left: QueryNode; right: QueryNode };

export interface ParsedQuery {
	/** One tree per `--query`; several are AND-ed. */
	nodes: QueryNode[];
	/** Every property the predicate reads, for inspect validation. */
	names: string[];
	/** Properties used bare (`disabled`, `!comment`), whose type decides the word. */
	bareNames: string[];
}

type Token =
	| { kind: "name"; text: string; at: number }
	| { kind: "op"; text: QueryComparison | "~" | "in"; at: number }
	| { kind: "value"; text: string; at: number }
	| { kind: "and" | "or" | "not" | "(" | ")"; at: number };

const NAME = /^\.?[A-Za-z][A-Za-z0-9.-]*/;
const BARE_VALUE_STOP = new Set([" ", "\t", "\r", "\n", "(", ")", '"']);
const ESCAPES: Record<string, string> = {
	'"': '"',
	"\\": "\\",
	$: "$",
	"?": "?",
	_: " ",
	n: "\n",
	r: "\r",
	t: "\t",
};

/** Parse one or more `--query` expressions offline. */
export function parseQueries(expressions: readonly string[]): ParsedQuery {
	const nodes = expressions.map(parseQuery);
	const names = new Set<string>();
	const bareNames = new Set<string>();
	const visit = (node: QueryNode): void => {
		switch (node.kind) {
			case "truthy":
				names.add(node.name);
				bareNames.add(node.name);
				return;
			case "compare":
				names.add(node.name);
				return;
			case "not":
				visit(node.operand);
				return;
			default:
				visit(node.left);
				visit(node.right);
		}
	};
	nodes.forEach(visit);
	return { nodes, names: [...names], bareNames: [...bareNames] };
}

/**
 * Query words (no `?` prefix) in stack order. `booleans` names the bare
 * properties the device reports as booleans; any other bare name means "is set".
 */
export function compileQueryWords(
	parsed: ParsedQuery,
	booleans: ReadonlySet<string>,
): string[] {
	const words: string[] = [];
	parsed.nodes.forEach((node, index) => {
		emit(node, words, booleans);
		if (index > 0) words.push("#&");
	});
	return words;
}

export function parseQuery(expression: string): QueryNode {
	const tokens = tokenize(expression);
	let position = 0;
	const peek = () => tokens[position];

	const fail = (summary: string, at: number): never => {
		throw invalidQuery(expression, summary, at);
	};

	const parseOr = (): QueryNode => {
		let left = parseAnd();
		while (peek()?.kind === "or") {
			position++;
			left = { kind: "or", left, right: parseAnd() };
		}
		return left;
	};

	const parseAnd = (): QueryNode => {
		let left = parseUnary();
		while (peek()?.kind === "and") {
			position++;
			left = { kind: "and", left, right: parseUnary() };
		}
		return left;
	};

	const parseUnary = (): QueryNode => {
		const token = peek();
		if (token === undefined) {
			return fail(
				"The expression ends where a condition was expected.",
				expression.length,
			);
		}
		if (token.kind === "not") {
			position++;
			const next = tokens[position];
			if (next?.kind === "name" && tokens[position + 1]?.kind === "op") {
				return fail(
					`RouterOS reads \`!${next.text}…\` as \`(!${next.text})…\`; write \`!(${next.text}…)\` or use \`!=\`.`,
					token.at,
				);
			}
			return { kind: "not", operand: parseUnary() };
		}
		if (token.kind === "(") {
			position++;
			const inner = parseOr();
			const close = peek();
			if (close?.kind !== ")") {
				return fail("A `(` is never closed.", token.at);
			}
			position++;
			return inner;
		}
		if (token.kind !== "name") {
			return fail("Expected a property name.", token.at);
		}
		if (token.text === "not") {
			return fail("RouterOS has no `not` operator; use `!`.", token.at);
		}
		position++;
		const op = peek();
		if (op?.kind !== "op") {
			return { kind: "truthy", name: token.text };
		}
		position++;
		if (op.text === "~" || op.text === "in") {
			throw unsupportedOperator(expression, op.text, op.at);
		}
		const value = peek();
		if (value?.kind !== "value") {
			return fail(`\`${op.text}\` needs a value after it.`, op.at);
		}
		position++;
		return {
			kind: "compare",
			name: token.text,
			op: op.text,
			value: value.text,
		};
	};

	const node = parseOr();
	const rest = peek();
	if (rest !== undefined) {
		fail(
			rest.kind === ")"
				? "A `)` has no matching `(`."
				: "Join conditions with `and` or `or`.",
			rest.at,
		);
	}
	return node;
}

function emit(
	node: QueryNode,
	words: string[],
	booleans: ReadonlySet<string>,
): void {
	switch (node.kind) {
		case "truthy":
			words.push(booleans.has(node.name) ? `${node.name}=yes` : node.name);
			return;
		case "compare": {
			const { name, value } = node;
			switch (node.op) {
				case "=":
					words.push(`${name}=${value}`);
					return;
				case "!=":
					words.push(`${name}=${value}`, "#!");
					return;
				// `where` counts a row without the property as smaller than any
				// value; API `<`/`>` skip such rows, so `<` adds them back (`-a`).
				case "<":
					words.push(`<${name}=${value}`, `-${name}`, "#|");
					return;
				case ">":
					words.push(`>${name}=${value}`);
					return;
				case "<=":
					words.push(`>${name}=${value}`, "#!");
					return;
				case ">=":
					words.push(`<${name}=${value}`, `-${name}`, "#|", "#!");
					return;
			}
			return;
		}
		case "not":
			emit(node.operand, words, booleans);
			words.push("#!");
			return;
		case "and":
		case "or":
			emit(node.left, words, booleans);
			emit(node.right, words, booleans);
			words.push(node.kind === "and" ? "#&" : "#|");
			return;
	}
}

function tokenize(expression: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	// After a comparison operator the next token is a value, never a name.
	let wantValue = false;
	while (index < expression.length) {
		const char = expression[index] as string;
		if (/\s/.test(char)) {
			index++;
			continue;
		}
		const at = index;
		if (wantValue) {
			wantValue = false;
			if (char === '"') {
				const { text, end } = readQuoted(expression, index);
				tokens.push({ kind: "value", text, at });
				index = end;
				continue;
			}
			let end = index;
			while (
				end < expression.length &&
				!BARE_VALUE_STOP.has(expression[end] as string)
			) {
				end++;
			}
			const text = expression.slice(index, end);
			if (text.length === 0) {
				break;
			}
			rejectScriptValue(expression, text, at);
			tokens.push({ kind: "value", text, at });
			index = end;
			continue;
		}
		const two = expression.slice(index, index + 2);
		if (two === "&&" || two === "||") {
			tokens.push({ kind: two === "&&" ? "and" : "or", at });
			index += 2;
			continue;
		}
		if (two === "!=" || two === "<=" || two === ">=") {
			tokens.push({ kind: "op", text: two, at });
			index += 2;
			wantValue = true;
			continue;
		}
		if (char === "=" || char === "<" || char === ">" || char === "~") {
			tokens.push({ kind: "op", text: char, at });
			index++;
			wantValue = true;
			continue;
		}
		if (char === "!" || char === "(" || char === ")") {
			tokens.push({ kind: char === "!" ? "not" : char, at });
			index++;
			continue;
		}
		const name = NAME.exec(expression.slice(index))?.[0];
		if (name === undefined) {
			throw invalidQuery(
				expression,
				`Unexpected \`${char}\`; expected a property name, \`!\` or \`(\`.`,
				at,
			);
		}
		if (name === "and" || name === "or") {
			tokens.push({ kind: name, at });
		} else if (name === "in") {
			tokens.push({ kind: "op", text: "in", at });
			wantValue = true;
		} else {
			tokens.push({ kind: "name", text: name, at });
		}
		index += name.length;
	}
	return tokens;
}

function readQuoted(
	expression: string,
	start: number,
): { text: string; end: number } {
	let text = "";
	let index = start + 1;
	while (index < expression.length) {
		const char = expression[index] as string;
		if (char === '"') {
			return { text, end: index + 1 };
		}
		if (char === "$") {
			throw scriptValue(expression, start);
		}
		if (char !== "\\") {
			text += char;
			index++;
			continue;
		}
		const next = expression[index + 1] ?? "";
		const hex = expression.slice(index + 1, index + 3);
		if (next in ESCAPES) {
			text += ESCAPES[next];
			index += 2;
		} else if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
			text += String.fromCharCode(Number.parseInt(hex, 16));
			index += 3;
		} else {
			throw invalidQuery(
				expression,
				`\`\\${next}\` is not a RouterOS string escape.`,
				index,
			);
		}
	}
	throw invalidQuery(expression, "A quoted value is never closed.", start);
}

function rejectScriptValue(expression: string, text: string, at: number): void {
	if (text.startsWith("$") || text.startsWith("[") || text.startsWith("{")) {
		throw scriptValue(expression, at);
	}
}

function invalidQuery(
	expression: string,
	summary: string,
	at: number,
): CentrsError {
	return new CentrsError({
		code: "input/invalid-query",
		summary: `Invalid --query: ${summary}`,
		remediation:
			'Write the query as you would after `print where`: `name=ether1`, `mtu>=1500 and !disabled`, `(type=ether or type=vlan)`. Quote values with spaces: `comment="uplink a"`.',
		context: { query: expression, offset: at },
	});
}

function unsupportedOperator(
	expression: string,
	operator: "~" | "in",
	at: number,
): CentrsError {
	return new CentrsError({
		code: "input/unsupported-query",
		summary:
			operator === "~"
				? "`~` (regex) has no RouterOS API query word, so --query cannot run it on the router."
				: "`in` (prefix membership) has no RouterOS API query word, so --query cannot run it on the router.",
		remediation:
			"Read the rows without the condition and filter them yourself, or run the console form with `centrs execute <router> '<menu>/print where …'` (console text, not rows).",
		context: { query: expression, operator, offset: at },
	});
}

function scriptValue(expression: string, at: number): CentrsError {
	return new CentrsError({
		code: "input/unsupported-query",
		summary:
			"--query values are literal: `$variables`, `[commands]` and `{arrays}` need RouterOS's script evaluator.",
		remediation:
			"Put the literal value in the query (escape a `$` inside quotes as `\\$`), or run the console form with `centrs execute`.",
		context: { query: expression, offset: at },
	});
}
