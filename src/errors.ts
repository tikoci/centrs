/**
 * Base URL for the human-readable error pages. Every `CentrsError.detailsUrl`
 * is this prefix plus the slash-namespaced code. Exported so the error catalog
 * and MCP resources share one definition (see `src/core/error-catalog.ts`).
 */
export const ERROR_DETAILS_BASE_URL = "https://tikoci.github.io/centrs/errors/";

export type CentrsErrorCode =
	| `auth/${string}`
	| `cdb/${string}`
	| `discover/${string}`
	| `identity/${string}`
	| `input/${string}`
	| `internal/${string}`
	| `mndp/${string}`
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

export function formatCentrsErrorText(
	error: CentrsError | SerializedCentrsError,
	options: { verbose?: boolean } = {},
): string {
	const serialized = serializeCentrsError(error);
	const lines = [`[${serialized.code}] ${serialized.summary}`];

	if (serialized.position) {
		// RouterOS's authoritative byte column (1-based); see RouterOsErrorPosition.
		lines.push(
			`At: line ${serialized.position.line}, column ${serialized.position.column} (RouterOS byte offset)`,
		);
	}

	if (serialized.remediation) {
		lines.push(`Fix: ${serialized.remediation}`);
	}

	if (serialized.detailsUrl) {
		lines.push(`Details: ${serialized.detailsUrl}`);
	}

	if (options.verbose && serialized.context) {
		lines.push("");
		lines.push(JSON.stringify(serialized.context, null, 2));
	}

	return lines.join("\n");
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
