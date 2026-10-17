/**
 * Read the pinned corpus the way every `explain` census must (#498).
 *
 * `corpus-fetch.ts` answers WHICH snapshot. This module answers how to read it,
 * so that no census re-derives the population, the session set or the device
 * verdict on its own. Each of those had a private copy before schema 5, and
 * each copy was wrong in its own way:
 *
 * - **Population.** `source_scripts` also holds upstream auxiliary
 *   collections: `capture-controls` (7 challenge scripts that exercise the
 *   classifier) and `wiresage-conformance` (875 synthetic grammar cases,
 *   lsp-routeros-ts#42). Counting them moves every denominator. The
 *   population is `v_corpus_population`, never the table, and an observation
 *   belongs to it by `script_id`. A path-prefix filter names the collections
 *   it knows, so the next collection upstream adds would leak through it.
 * - **Sessions.** "The builds where `coverage_class = 'complete'`" was a label
 *   over legacy rows, and schema 5 renamed it and stopped vouching for it. A
 *   comparable measurement is now an explicit run id: `capture_channels`
 *   names one parse run and one highlight run per release channel, captured in
 *   one environment. Firmware alone is never a comparison key.
 * - **Verdict.** The old oracle was "IL that opens with a prose verb is a
 *   rejection, anything else is an accept". That read 87 scripts at 7.24.2 as
 *   accepted while their IL carried an embedded `bad command name …`
 *   (lsp-routeros-ts#37). `response_class` is the upstream classifier's
 *   answer, so it is read here instead of re-guessed per census.
 *
 * Legacy runs (`legacy:N`, `legacy-unknown-input`) are history: their input
 * bytes and device environment are unknown. Their ids are local to one DB
 * build, so nothing durable may cite them. Cite the version.
 */

import type { Database } from "bun:sqlite";
import { compareRouterOsVersion } from "../src/core/preflight.ts";
import { sha256File } from "./corpus-fetch.ts";

/** The oldest snapshot schema these readers understand. */
export const CORPUS_SCHEMA_VERSION = 5;

/**
 * Refuse a snapshot older than schema 5, with the fix in the message. Reading a
 * schema-4 DB through these queries would fail on a missing view, which says
 * nothing about the repin that is actually needed.
 */
export function requireCorpusSchema(db: Database): void {
	const row = db
		.query("SELECT value FROM corpus_metadata WHERE key = 'schema_version'")
		.get() as { value: string } | null;
	const version = Number(row?.value ?? 0);
	if (version >= CORPUS_SCHEMA_VERSION) return;
	throw new Error(
		`the corpus is schema v${version}, and the censuses read schema v${CORPUS_SCHEMA_VERSION} ` +
			"(capture sessions and response classes). Re-pin with " +
			"`bun run corpus:fetch --repin <40-hex commit>`, and fast-forward a sibling " +
			"lsp-routeros-ts checkout if one is shadowing the cache.",
	);
}

export interface PopulationScript {
	id: number;
	path: string;
	collection: string;
	text: string;
	hasCliPrompt: number;
}

/** The study population, auxiliary collections excluded, in path order. */
export function populationScripts(db: Database): PopulationScript[] {
	requireCorpusSchema(db);
	return db
		.query(
			"SELECT id, path, collection, text, has_cli_prompt AS hasCliPrompt " +
				"FROM v_corpus_population ORDER BY path",
		)
		.all() as PopulationScript[];
}

/**
 * What every census figure states about its input: the snapshot it read (the
 * first 12 hex of the DB's sha256, as `describeResolution` prints it) and the
 * rows the population left out, by collection.
 */
export interface CorpusProvenance {
	snapshot: string;
	excluded: Record<string, number>;
}

export function corpusProvenance(
	db: Database,
	dbPath: string,
): CorpusProvenance {
	requireCorpusSchema(db);
	const rows = db
		.query(
			"SELECT collection, COUNT(*) AS n FROM source_scripts " +
				"WHERE id NOT IN (SELECT id FROM v_corpus_population) " +
				"GROUP BY collection ORDER BY collection",
		)
		.all() as { collection: string; n: number }[];
	return {
		snapshot: sha256File(dbPath).slice(0, 12),
		excluded: Object.fromEntries(rows.map((r) => [r.collection, r.n])),
	};
}

/** The excluded rows as prose: the total, then each collection's count. */
export function describeExcluded(excluded: Record<string, number>): string {
	const entries = Object.entries(excluded);
	const total = entries.reduce((sum, [, n]) => sum + n, 0);
	const parts = entries.map(([collection, n]) => `${n} \`${collection}\``);
	return `${total} auxiliary rows (${parts.join(", ")})`;
}

/**
 * The README clause that follows "covers N source scripts". Empty for a result
 * built without provenance (a unit test's synthetic census).
 */
export function describePopulation(p: Partial<CorpusProvenance>): string {
	if (p.snapshot === undefined) return "";
	const excluded =
		p.excluded === undefined
			? ""
			: `, with ${describeExcluded(p.excluded)} excluded`;
	return ` of corpus snapshot \`${p.snapshot}\`${excluded}`;
}

/** One release channel's recorded capture session. */
export interface ChannelSession {
	channel: string;
	version: string;
	parseRunId: string;
	highlightRunId: string;
	environmentSha256: string;
}

/** Every recorded channel session, oldest RouterOS version first. */
export function channelSessions(db: Database): ChannelSession[] {
	requireCorpusSchema(db);
	const rows = db
		.query(
			"SELECT channel, routeros_version AS version, parse_run_id AS parseRunId, " +
				"highlight_run_id AS highlightRunId, environment_sha256 AS environmentSha256 " +
				"FROM capture_channels",
		)
		.all() as ChannelSession[];
	if (rows.length === 0)
		throw new Error(
			"the corpus records no channel sessions (`capture_channels` is empty), " +
				"so there is no exact-input capture to measure against",
		);
	// The channel row and its two runs record the version independently, so a
	// session whose runs disagree with its label is caught rather than cited.
	const runVersion = db.query(
		"SELECT routeros_version AS version FROM capture_runs WHERE id = ?",
	);
	for (const row of rows)
		for (const runId of [row.parseRunId, row.highlightRunId]) {
			const run = runVersion.get(runId) as { version: string } | null;
			if (run?.version !== row.version)
				throw new Error(
					`the ${row.channel} session is labelled ${row.version}, but its run ` +
						`${runId} records ${run === null ? "nothing" : run.version}`,
				);
		}
	return rows.sort((a, b) => compareRouterOsVersion(a.version, b.version));
}

/** The session for one channel, by name (`stable`, `long-term`, …). */
export function channelSession(db: Database, channel: string): ChannelSession {
	const session = channelSessions(db).find((s) => s.channel === channel);
	if (session === undefined)
		throw new Error(`the corpus records no \`${channel}\` channel session`);
	return session;
}

/** The ids every census output names, so a figure states its sessions. */
export function describeSessions(sessions: readonly ChannelSession[]): string {
	return sessions
		.map((s) => `${s.channel} ${s.version} ${s.parseRunId.slice(0, 8)}`)
		.join(", ");
}

/**
 * The upstream classifier's parse verdict (`scripts/corpus-evidence.ts` in
 * lsp-routeros-ts). Only `il-no-recognized-diagnostic` is an accept. An
 * `embedded-diagnostic` row is IL whose text carries a device diagnostic, so
 * it is a rejection even though it does not open with prose.
 */
export const PARSE_RESPONSE_CLASSES = [
	"il-no-recognized-diagnostic",
	"embedded-diagnostic",
	"plain-diagnostic",
	"ambiguous-diagnostic",
	"unknown-response",
	"missing-response",
	"capture-failed",
] as const;

export type ParseResponseClass = (typeof PARSE_RESPONSE_CLASSES)[number];

const KNOWN_PARSE_CLASSES: ReadonlySet<string> = new Set(
	PARSE_RESPONSE_CLASSES,
);

export function isAcceptedParse(responseClass: string): boolean {
	return responseClass === "il-no-recognized-diagnostic";
}

/** One `:parse` observation of one population script. */
export interface ParseObservation {
	scriptId: number;
	path: string;
	version: string;
	runId: string;
	responseClass: ParseResponseClass;
	/** The device readout. Absent when the capture failed (the 413 row). */
	il: string | undefined;
}

/**
 * `:parse` observations of the population on the given runs, in run then path
 * order. The readout is `response_text` for both `parse-ret-v1` and
 * `legacy-text`; a `raw-json-v1` row is a failed acquisition and has none.
 */
export function parseObservations(
	db: Database,
	runIds: readonly string[],
): ParseObservation[] {
	requireCorpusSchema(db);
	const query = db.query(
		"SELECT o.script_id AS scriptId, o.source_path AS path, " +
			"r.routeros_version AS version, r.id AS runId, " +
			"o.response_class AS responseClass, o.response_text AS il, " +
			"o.acquisition_status AS acquisition " +
			"FROM capture_observations o JOIN capture_runs r ON r.id = o.run_id " +
			"JOIN v_corpus_population p ON p.id = o.script_id " +
			"WHERE r.id = ? AND r.probe = 'parseil' ORDER BY o.source_path",
	);
	const out: ParseObservation[] = [];
	for (const runId of runIds) {
		const rows = query.all(runId) as (Omit<ParseObservation, "il"> & {
			il: string | null;
			acquisition: string;
		})[];
		if (rows.length === 0)
			throw new Error(
				`the corpus has no parseil observations for run ${runId}`,
			);
		for (const { acquisition, il, ...row } of rows) {
			// A class this reader does not know would silently fall on the reject
			// side of `isAcceptedParse`. Refuse it, so a classifier change upstream
			// is read before it moves a figure.
			if (!KNOWN_PARSE_CLASSES.has(row.responseClass))
				throw new Error(
					`${row.path} on run ${runId} has response class ` +
						`${JSON.stringify(row.responseClass)}, which corpus-db.ts does not know`,
				);
			out.push({
				...row,
				il: acquisition === "ok" && il !== null ? il : undefined,
			});
		}
	}
	return out;
}

/** Every `:parse` run, channel sessions and legacy history alike. */
export function allParseRunIds(db: Database): string[] {
	requireCorpusSchema(db);
	return (
		db
			.query("SELECT id FROM capture_runs WHERE probe = 'parseil' ORDER BY id")
			.all() as { id: string }[]
	).map((row) => row.id);
}

/** A run-length `[text, class]` list, the slice fixture's stream format. */
export type HighlightPair = [text: string, cls: string];

/** One `highlight` observation of one population script. */
export interface HighlightObservation {
	path: string;
	/** The bytes the device was sent: an ASCII-replaced 32,767-unit prefix. */
	submitted: string;
	/** Code units the capture replaced with `?` before sending. */
	replacedCodeUnits: number;
	truncated: boolean;
	aligned: boolean;
	acquired: boolean;
	pairs: HighlightPair[] | undefined;
}

/**
 * Expand a `highlight-rle-v1` response (`[[class, count], …]`, one count per
 * submitted character) into `[text, class]` runs over the submitted text.
 * Throws when the runs do not cover the text exactly, since a short stream
 * would read as the device having nothing to say about the tail.
 */
export function decodeHighlightRuns(
	runs: readonly (readonly [string, number])[],
	submitted: string,
): HighlightPair[] {
	const pairs: HighlightPair[] = [];
	let at = 0;
	for (const [cls, count] of runs) {
		// A run with no characters classes nothing, and emitting it would
		// split one neighboring run into two.
		if (count === 0) continue;
		const text = submitted.slice(at, at + count);
		if (text.length !== count)
			throw new Error(
				`highlight runs overrun the submitted text (${at + count} > ${submitted.length})`,
			);
		const last = pairs.at(-1);
		if (last !== undefined && last[1] === cls) last[0] += text;
		else pairs.push([text, cls]);
		at += count;
	}
	if (at !== submitted.length)
		throw new Error(
			`highlight runs cover ${at} of ${submitted.length} submitted characters`,
		);
	return pairs;
}

/** `highlight` observations of the population on one run, in path order. */
export function highlightObservations(
	db: Database,
	runId: string,
): HighlightObservation[] {
	requireCorpusSchema(db);
	const rows = db
		.query(
			"SELECT o.source_path AS path, o.acquisition_status AS acquisition, " +
				"o.response_encoding AS encoding, o.response_json AS response, " +
				"o.highlight_json AS highlight, i.input_json AS input, " +
				"v.submitted_text AS submitted " +
				"FROM capture_observations o JOIN capture_runs r ON r.id = o.run_id " +
				"JOIN v_corpus_population p ON p.id = o.script_id " +
				"LEFT JOIN capture_inputs i ON i.id = o.input_id " +
				"LEFT JOIN v_capture_inputs v ON v.observation_id = o.id " +
				"WHERE r.id = ? AND r.probe = 'highlight' ORDER BY o.source_path",
		)
		.all(runId) as {
		path: string;
		acquisition: string;
		encoding: string;
		response: string | null;
		highlight: string | null;
		input: string | null;
		submitted: string | null;
	}[];
	if (rows.length === 0)
		throw new Error(
			`the corpus has no highlight observations for run ${runId}`,
		);
	return rows.map((row) => {
		const input = JSON.parse(row.input ?? "{}") as {
			truncated?: boolean;
			replacedCodeUnits?: number;
		};
		const summary = JSON.parse(row.highlight ?? "{}") as { aligned?: boolean };
		const acquired =
			row.acquisition === "ok" && row.encoding === "highlight-rle-v1";
		const aligned = summary.aligned === true;
		const submitted = row.submitted ?? "";
		// A misaligned stream does not cover its submitted text, so it carries
		// no pairs (no classes past a desync). Decoding it would throw and take
		// the whole run down with it, hiding the row a caller wants to report.
		let pairs: HighlightPair[] | undefined;
		if (acquired && aligned && row.response !== null) {
			const [first] = JSON.parse(row.response) as {
				highlight: [string, number][];
			}[];
			pairs = decodeHighlightRuns(first?.highlight ?? [], submitted);
		}
		return {
			path: row.path,
			submitted,
			replacedCodeUnits: input.replacedCodeUnits ?? 0,
			truncated: input.truncated === true,
			aligned,
			acquired,
			pairs,
		};
	});
}
