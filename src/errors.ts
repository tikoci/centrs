/**
 * Base URL for the human-readable error pages. Every `CentrsError.detailsUrl`
 * is this prefix plus the slash-namespaced code. Exported so the error catalog
 * and MCP resources share one definition (see `src/core/error-catalog.ts`).
 */
export const ERROR_DETAILS_BASE_URL = "https://tikoci.github.io/centrs/errors/";

/**
 * Remediation for a device-stage `:parse` rejection. It does not claim the
 * syntax is wrong: RouterOS rejects an absent menu (unknown path, package not
 * installed) in the same words, and #361 tracks telling those apart.
 */
export const SYNTAX_REJECTED_REMEDIATION =
	"RouterOS refused to parse this command; its own words are in `Device said`. Check the syntax with `centrs explain '<command>'`. A menu that does not exist on this device (an unknown path, or a package that is not installed) is rejected the same way.";

export type CentrsErrorCode =
	| `auth/${string}`
	| `cdb/${string}`
	| `discover/${string}`
	| `identity/${string}`
	| `input/${string}`
	| `internal/${string}`
	| `mndp/${string}`
	| `quickchr/${string}`
	| `routeros/${string}`
	| `settings/${string}`
	| `target/${string}`
	| `tool/${string}`
	| `transport/${string}`
	| `usage/${string}`
	| `validation/${string}`;

/**
 * A RouterOS-reported source location for a parse/syntax fault. RouterOS prints
 * `(line N column M)` on a console `:parse` rejection; `column` is RouterOS's
 * **authoritative 1-based BYTE offset**, not a JS character index — the RouterOS
 * console is not Unicode-aware, so a multibyte command can make the byte column
 * differ from a code-point index. Carried verbatim; never re-derived.
 */
export interface RouterOsErrorPosition {
	line: number;
	column: number;
}

export interface CentrsErrorInit {
	code: CentrsErrorCode;
	summary: string;
	remediation?: string;
	context?: Record<string, unknown>;
	/** RouterOS-reported byte offset of a parse fault, when one is available. */
	position?: RouterOsErrorPosition;
	cause?: unknown;
	causeData?: unknown;
}

export interface SerializedCentrsError {
	name: "CentrsError";
	code: CentrsErrorCode;
	summary: string;
	message: string;
	remediation?: string;
	detailsUrl: string;
	details_url: string;
	context?: Record<string, unknown>;
	position?: RouterOsErrorPosition;
	cause?: unknown;
}

export class CentrsError extends Error {
	readonly code: CentrsErrorCode;
	readonly summary: string;
	readonly remediation?: string;
	readonly detailsUrl: string;
	readonly context?: Record<string, unknown>;
	readonly position?: RouterOsErrorPosition;
	readonly causeData?: unknown;

	constructor(init: CentrsErrorInit) {
		super(init.summary, init.cause ? { cause: init.cause } : undefined);
		this.name = "CentrsError";
		this.code = init.code;
		this.summary = init.summary;
		this.remediation = init.remediation;
		this.detailsUrl = `${ERROR_DETAILS_BASE_URL}${init.code}`;
		this.context = init.context;
		this.position = init.position;
		this.causeData = init.causeData;
	}

	toJSON(): SerializedCentrsError {
		return serializeCentrsError(this);
	}
}

export function serializeCentrsError(
	error: CentrsError | SerializedCentrsError,
): SerializedCentrsError {
	if (error instanceof CentrsError) {
		return {
			name: "CentrsError",
			code: error.code,
			summary: error.summary,
			message: error.message,
			remediation: error.remediation,
			detailsUrl: error.detailsUrl,
			details_url: error.detailsUrl,
			context: error.context,
			...(error.position ? { position: error.position } : {}),
			cause: error.causeData ?? serializeUnknownError(error.cause),
		};
	}

	return error;
}

export function asCentrsError(
	error: unknown,
	fallback: Omit<CentrsErrorInit, "cause">,
): CentrsError {
	if (error instanceof CentrsError) {
		return error;
	}

	return new CentrsError({
		...fallback,
		cause: error,
		causeData: serializeUnknownError(error),
	});
}

/**
 * The one text renderer for an error, shared by every command (GH#362).
 *
 * Order: header, where (`At:`), the device's own words (`Device said:`), `Fix:`,
 * `Details:`. Where and the device's words print without `--verbose`: they are
 * what lets a caller recover from a remediation that names the wrong cause.
 * `--verbose` adds the full `context` object. A command that has more to say
 * (warnings, tips) appends to this output; it never re-derives the header.
 */
export function formatCentrsErrorText(
	error: CentrsError | SerializedCentrsError,
	options: { verbose?: boolean } = {},
): string {
	const serialized = serializeCentrsError(error);
	const lines = [`[${serialized.code}] ${terminalSafe(serialized.summary)}`];

	if (serialized.position) {
		// RouterOS's authoritative byte column (1-based); see RouterOsErrorPosition.
		lines.push(
			`At: line ${serialized.position.line}, column ${serialized.position.column} (RouterOS byte offset)`,
		);
	} else {
		const offline = offlineSpanText(serialized.context);
		if (offline) lines.push(offline);
	}

	const deviceSaid = deviceSaidText(serialized);
	if (deviceSaid) {
		lines.push(`Device said: ${terminalSafe(deviceSaid)}`);
	}

	if (serialized.remediation) {
		lines.push(`Fix: ${terminalSafe(serialized.remediation)}`);
	}

	if (serialized.detailsUrl) {
		lines.push(`Details: ${serialized.detailsUrl}`);
	}

	if (options.verbose && serialized.context) {
		lines.push("");
		lines.push(terminalSafe(JSON.stringify(serialized.context, null, 2)));
	}

	return lines.join("\n");
}

const DEVICE_SAID_MAX = 240;

/**
 * Control characters other than tab and newline, C1 included. Summaries and
 * `detail` carry router-supplied text; an ESC or CR in it would drive the
 * terminal. `JSON.stringify` escapes C0 but not C1, so serialized excerpts need
 * this too. `--json` keeps the raw value.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
const TERMINAL_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function terminalSafe(text: string): string {
	return text.replace(TERMINAL_CONTROL, " ");
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * RouterOS's own verdict, from `context.detail`: the raw `:parse` return or the
 * trap / REST message, as `mapRouterOsError` and `classifyParseResult` store it.
 * Collapsed to one line and capped. Omitted when the summary already quotes it,
 * so a trap message is not printed twice. `--json` keeps it unabridged.
 */
function deviceSaidText(error: SerializedCentrsError): string | undefined {
	const detail = error.context?.["detail"];
	if (typeof detail !== "string") return undefined;
	const said = oneLine(detail);
	if (said.length === 0 || oneLine(error.summary).includes(said))
		return undefined;
	return said.length > DEVICE_SAID_MAX
		? `${said.slice(0, DEVICE_SAID_MAX)}…`
		: said;
}

/**
 * The offline gate's rejected byte range (`context.span`, 0-based, end-exclusive,
 * into `context.command`). Labelled as offline analysis so it is never mistaken
 * for a RouterOS-reported position (see `src/offline-gate.ts`).
 */
function offlineSpanText(
	context: Record<string, unknown> | undefined,
): string | undefined {
	const span = context?.["span"];
	if (
		!span ||
		typeof span !== "object" ||
		typeof (span as { start?: unknown }).start !== "number" ||
		typeof (span as { end?: unknown }).end !== "number"
	) {
		return undefined;
	}
	const { start, end } = span as { start: number; end: number };
	const command = context?.["command"];
	const excerpt =
		typeof command === "string" && end > start
			? `: ${terminalSafe(JSON.stringify(new TextDecoder().decode(new TextEncoder().encode(command).subarray(start, end))))}`
			: "";
	// Half-open, exactly as `context.span` carries it.
	return `At: bytes [${start}, ${end}) (offline analysis)${excerpt}`;
}

export function serializeUnknownError(error: unknown): unknown {
	if (error instanceof CentrsError) {
		return serializeCentrsError(error);
	}

	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			code: extractErrorCode(error),
		};
	}

	return error;
}

export function extractErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") {
		return undefined;
	}

	if ("code" in error && typeof error.code === "string") {
		return error.code;
	}

	if (
		"cause" in error &&
		error.cause &&
		typeof error.cause === "object" &&
		"code" in error.cause &&
		typeof error.cause.code === "string"
	) {
		return error.cause.code;
	}

	return undefined;
}
