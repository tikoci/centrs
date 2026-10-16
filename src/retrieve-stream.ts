/**
 * Line helpers shared by the two streaming forms of `retrieve`: `--follow`
 * (`src/retrieve-follow.ts`) and `--sample` (`src/retrieve-sample.ts`). Each
 * line is one envelope whose `meta.operation.stream` says what it is
 * (`commands/retrieve/README.md` → Follow, Sample). A stream opens with a
 * full-meta `started` line and ends with a full-meta `summary`; the data lines
 * between carry only `meta.operation` (#462, #473).
 */

import type { EnvelopeValidationMeta, Tip } from "./core/envelope.ts";
import { formatCentrsErrorLine } from "./errors.ts";
import {
	buildRetrieveErrorEnvelopeFromResolved,
	metaFromResolved,
	type ResolvedRetrieveRequest,
	type RetrieveErrorEnvelope,
	type RetrieveOutputFormat,
	type RetrieveStreamLine,
	type RetrieveStreamLineEnvelope,
	type RetrieveStreamMeta,
	type RetrieveSuccessEnvelope,
	retrieveRequestSummary,
} from "./retrieve.ts";

/** A full-meta stream line (`started`, `synced`, `summary`): `data` plus its marker. */
export function streamEnvelope(
	resolved: ResolvedRetrieveRequest,
	validation: EnvelopeValidationMeta,
	data: unknown,
	stream: RetrieveStreamMeta,
	tips: Tip[] = [],
): RetrieveSuccessEnvelope {
	return {
		ok: true,
		data,
		warnings: [],
		tips,
		meta: metaFromResolved(resolved, validation, {
			kind: "data",
			objectCount: data === null ? 0 : Array.isArray(data) ? data.length : 1,
			request: retrieveRequestSummary(resolved),
			auth: {
				username: resolved.auth.username,
				passwordProvided: resolved.auth.passwordProvided,
			},
			stream,
		}),
	};
}

/** A `frame` or `sample` line: only its `meta.operation` (#462, #473). */
export function streamLineEnvelope(
	data: unknown,
	stream: RetrieveStreamMeta,
	tips: Tip[] = [],
): RetrieveStreamLineEnvelope {
	return {
		ok: true,
		data,
		warnings: [],
		tips,
		meta: {
			operation: {
				kind: "data",
				objectCount: data === null ? 0 : Array.isArray(data) ? data.length : 1,
				stream,
			},
		},
	};
}

/**
 * The failed summary that ends a stream after it started: the error, plus the
 * partial counts as a `summary` marker. `stopReason` is `routeros-error` when
 * RouterOS answered with an error and `transport-error` for anything else
 * (the same split as `api --stream`); `error.code` names the cause.
 */
export function failedStreamEnvelope(
	resolved: ResolvedRetrieveRequest,
	validation: EnvelopeValidationMeta,
	error: unknown,
	summary: (
		stopReason: "routeros-error" | "transport-error",
	) => Extract<RetrieveStreamMeta, { kind: "summary" }>,
	objectCount: number,
): RetrieveErrorEnvelope {
	const envelope = buildRetrieveErrorEnvelopeFromResolved(resolved, error);
	envelope.meta.validation = validation;
	if (envelope.meta.operation) {
		envelope.meta.operation.objectCount = objectCount;
		envelope.meta.operation.stream = summary(
			envelope.error.code.startsWith("routeros/")
				? "routeros-error"
				: "transport-error",
		);
	}
	return envelope;
}

/**
 * One stream envelope as one line: compact NDJSON for every structured format
 * (a multi-line YAML document cannot be a stream line), and a short row for
 * `text`. Router text is JSON-escaped so it cannot carry terminal control
 * bytes. In text, only `frame` and `sample` rows are data
 * ({@link isStreamDataLine}); the CLI writes the rest to stderr, and an empty
 * string (a `started` line without tips) prints nothing.
 */
export function renderRetrieveStreamLine(
	envelope: RetrieveStreamLine,
	format: RetrieveOutputFormat,
): string {
	if (format !== "text") return JSON.stringify(envelope);
	if (!envelope.ok) return formatCentrsErrorLine(envelope.error);
	const stream = envelope.meta.operation?.stream;
	switch (stream?.kind) {
		case "started":
			return envelope.tips
				.map((tip) => `tip: ${tip.message}${tip.fix ? ` ${tip.fix}` : ""}`)
				.join("\n");
		case "frame": {
			const head = `${stream.index}\t${stream.phase}\t${stream.change}\t${escaped(stream.id)}`;
			return stream.change === "removed"
				? `${head}\t(${stream.source})`
				: `${head}\t${JSON.stringify(envelope.data)}`;
		}
		case "synced":
			return `— synced: ${stream.rows} row(s)`;
		case "sample":
			return `${stream.index}\t${stream.at}\t${JSON.stringify(envelope.data)}`;
		case "summary":
			return "samples" in stream
				? `— ${stream.stopReason}: ${stream.samples} sample(s) in ${stream.durationMs}ms`
				: `— ${stream.stopReason}: ${stream.snapshot} snapshot, ${stream.changes} change(s), ${stream.sweeps} sweep(s) in ${stream.durationMs}ms`;
		default:
			return JSON.stringify(envelope.data);
	}
}

/** Whether a stream line is a data row: text stdout carries only these (#473). */
export function isStreamDataLine(envelope: RetrieveStreamLine): boolean {
	const kind = envelope.ok ? envelope.meta.operation?.stream?.kind : undefined;
	return kind === "frame" || kind === "sample";
}

function escaped(text: string): string {
	return JSON.stringify(text).slice(1, -1);
}
