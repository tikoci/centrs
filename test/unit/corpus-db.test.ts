/**
 * #498 — the schema-5 corpus readers every census shares. These run on a
 * synthetic in-memory DB with the upstream table and view names, so they need
 * no `corpus.sqlite`; the real snapshot is exercised by the census `--check`
 * gates in ci.yaml's `corpus` job.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	channelSession,
	channelSessions,
	decodeHighlightRuns,
	describePopulation,
	highlightObservations,
	isAcceptedParse,
	parseObservations,
	populationScripts,
	requireCorpusSchema,
} from "../../scripts/corpus-db.ts";

function corpus(schemaVersion = 5): Database {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE corpus_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE source_scripts (id INTEGER PRIMARY KEY, path TEXT, collection TEXT,
			text TEXT, has_cli_prompt INTEGER, sha256 TEXT);
		CREATE VIEW v_corpus_population AS
			SELECT * FROM source_scripts WHERE collection != 'capture-controls';
		CREATE TABLE capture_runs (id TEXT PRIMARY KEY, probe TEXT, routeros_version TEXT);
		CREATE TABLE capture_channels (channel TEXT PRIMARY KEY, routeros_version TEXT,
			parse_run_id TEXT, highlight_run_id TEXT, environment_sha256 TEXT);
		CREATE TABLE capture_inputs (id TEXT PRIMARY KEY, input_json TEXT);
		CREATE TABLE capture_observations (id INTEGER PRIMARY KEY, run_id TEXT, script_id INTEGER,
			source_path TEXT, source_sha256 TEXT, input_id TEXT, acquisition_status TEXT,
			response_class TEXT, response_text TEXT, response_json TEXT,
			response_encoding TEXT, highlight_json TEXT);
		CREATE VIEW v_capture_inputs AS SELECT o.id AS observation_id,
			(SELECT s.text FROM source_scripts s WHERE s.sha256 = o.source_sha256) AS submitted_text
			FROM capture_observations o;
	`);
	db.run("INSERT INTO corpus_metadata VALUES ('schema_version', ?)", [
		String(schemaVersion),
	]);
	db.run(`INSERT INTO source_scripts VALUES
		(1, 'b.rsc', 'root', ':put 1', 0, 'h1'),
		(2, 'a.rsc', 'root', '/x', 0, 'h2'),
		(3, 'capture-controls/c.rsc', 'capture-controls', ':put', 0, 'h3')`);
	db.run(`INSERT INTO capture_runs VALUES
		('lt-parse', 'parseil', '7.23.8'), ('st-parse', 'parseil', '7.24.5'),
		('st-hl', 'highlight', '7.24.5'), ('lt-hl', 'highlight', '7.23.8')`);
	db.run(`INSERT INTO capture_channels VALUES
		('stable', '7.24.5', 'st-parse', 'st-hl', 'e2'),
		('long-term', '7.23.8', 'lt-parse', 'lt-hl', 'e1')`);
	db.run(`INSERT INTO capture_observations
		(run_id, script_id, source_path, source_sha256, input_id, acquisition_status,
			response_class, response_text, response_json, response_encoding, highlight_json) VALUES
		('st-parse', 1, 'b.rsc', 'h1', NULL, 'ok', 'il-no-recognized-diagnostic',
			'(evl /putmessage=1)', '{}', 'parse-ret-v1', NULL),
		('st-parse', 2, 'a.rsc', 'h2', NULL, 'failed', 'capture-failed', NULL, '{}', 'raw-json-v1', NULL),
		('st-parse', 3, 'capture-controls/c.rsc', 'h3', NULL, 'ok', 'plain-diagnostic',
			'syntax error (line 1 column 5)', '{}', 'parse-ret-v1', NULL),
		('st-hl', 1, 'b.rsc', 'h1', 'i1', 'ok', 'highlight-no-hard-error', NULL,
			'[{"highlight":[["dir",1],["cmd",3],["none",1],["cmd",0],["none",1]]}]',
			'highlight-rle-v1', '{"aligned":true}')`);
	db.run(
		"INSERT INTO capture_inputs VALUES ('i1', '{\"truncated\":false,\"replacedCodeUnits\":0}')",
	);
	return db;
}

describe("corpus-db readers (#498)", () => {
	test("a pre-schema-5 snapshot is refused with the repin in the message", () => {
		expect(() => requireCorpusSchema(corpus(4))).toThrow(/--repin/);
	});

	test("the population leaves out the capture controls, in path order", () => {
		expect(populationScripts(corpus()).map((s) => s.path)).toEqual([
			"a.rsc",
			"b.rsc",
		]);
	});

	test("sessions sort by RouterOS version and are found by channel", () => {
		const db = corpus();
		expect(channelSessions(db).map((s) => s.channel)).toEqual([
			"long-term",
			"stable",
		]);
		expect(channelSession(db, "stable").parseRunId).toBe("st-parse");
		expect(() => channelSession(db, "testing")).toThrow(/testing/);
	});

	test("parse observations skip controls, and a failed capture has no readout", () => {
		const rows = parseObservations(corpus(), ["st-parse"]);
		expect(rows.map((r) => [r.path, r.responseClass, r.il])).toEqual([
			["a.rsc", "capture-failed", undefined],
			["b.rsc", "il-no-recognized-diagnostic", "(evl /putmessage=1)"],
		]);
		expect(() => parseObservations(corpus(), ["lt-parse"])).toThrow(/lt-parse/);
	});

	test("only il-no-recognized-diagnostic is an accept", () => {
		expect(isAcceptedParse("il-no-recognized-diagnostic")).toBe(true);
		expect(isAcceptedParse("embedded-diagnostic")).toBe(false);
		expect(isAcceptedParse("plain-diagnostic")).toBe(false);
	});

	test("highlight runs expand over the submitted text, merging equal neighbors", () => {
		const [row] = highlightObservations(corpus(), "st-hl");
		expect(row?.pairs).toEqual([
			[":", "dir"],
			["put", "cmd"],
			[" 1", "none"],
		]);
		expect(row?.aligned).toBe(true);
	});

	test("a highlight stream that does not cover the text exactly is refused", () => {
		expect(() => decodeHighlightRuns([["cmd", 2]], "abc")).toThrow(/2 of 3/);
		expect(() => decodeHighlightRuns([["cmd", 4]], "abc")).toThrow(/overrun/);
	});

	test("the README clause states the snapshot and the exclusion", () => {
		expect(
			describePopulation({ snapshot: "da632dc8e85d", controlsExcluded: 7 }),
		).toBe(
			" of corpus snapshot `da632dc8e85d`, with the 7 `capture-controls` rows excluded",
		);
		expect(describePopulation({})).toBe("");
	});
});
