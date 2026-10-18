/**
 * #498 — the schema-5 corpus readers every census shares. These run on a
 * synthetic in-memory DB with the upstream table and view names, so they need
 * no `corpus.sqlite`; the real snapshot is exercised by the census `--check`
 * gates in ci.yaml's `corpus` job.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONFORMANCE_COLLECTION,
	channelSession,
	channelSessions,
	conformanceCases,
	corpusProvenance,
	decodeHighlightRuns,
	describeExcluded,
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
			SELECT * FROM source_scripts
			WHERE collection NOT IN ('capture-controls', 'wiresage-conformance', 'next-collection');
		CREATE TABLE capture_runs (id TEXT PRIMARY KEY, probe TEXT, routeros_version TEXT);
		CREATE TABLE capture_channels (channel TEXT PRIMARY KEY, routeros_version TEXT,
			parse_run_id TEXT, highlight_run_id TEXT, environment_sha256 TEXT);
		CREATE TABLE capture_inputs (id TEXT PRIMARY KEY, input_json TEXT);
		CREATE TABLE capture_observations (id INTEGER PRIMARY KEY, run_id TEXT, script_id INTEGER,
			source_path TEXT, source_sha256 TEXT, input_id TEXT, acquisition_status TEXT,
			response_class TEXT, response_text TEXT, response_json TEXT,
			response_encoding TEXT, highlight_json TEXT);
		CREATE TABLE third_party_cases (script_id INTEGER PRIMARY KEY, upstream_id TEXT,
			upstream_section TEXT, upstream_index INTEGER, upstream_revision TEXT,
			upstream_source TEXT, upstream_oracle TEXT, upstream_valid INTEGER,
			source_sha256 TEXT, upstream_metadata_json TEXT);
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
		(3, 'capture-controls/c.rsc', 'capture-controls', ':put', 0, 'h3'),
		(4, 'wiresage-conformance/e/e14.rsc', 'wiresage-conformance', ':put ()', 0, 'h4'),
		(5, 'next-collection/x.rsc', 'next-collection', ':put 5', 0, 'h5')`);
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
		('st-parse', 4, 'wiresage-conformance/e/e14.rsc', 'h4', NULL, 'ok', 'plain-diagnostic',
			'syntax error (line 1 column 7)', '{}', 'parse-ret-v1', NULL),
		('st-parse', 5, 'next-collection/x.rsc', 'h5', NULL, 'ok', 'il-no-recognized-diagnostic',
			'(evl /putmessage=5)', '{}', 'parse-ret-v1', NULL),
		('st-hl', 1, 'b.rsc', 'h1', 'i1', 'ok', 'highlight-no-hard-error', NULL,
			'[{"highlight":[["dir",1],["cmd",3],["none",1],["cmd",0],["none",1]]}]',
			'highlight-rle-v1', '{"aligned":true}'),
		('st-hl', 2, 'a.rsc', 'h2', 'i1', 'ok', 'highlight-no-hard-error', NULL,
			'[{"highlight":[["dir",5]]}]', 'highlight-rle-v1', '{"aligned":false}'),
		('st-hl', 4, 'wiresage-conformance/e/e14.rsc', 'h4', 'i1', 'ok', 'highlight-no-hard-error', NULL,
			'[{"highlight":[["cmd",7]]}]', 'highlight-rle-v1', '{"aligned":true}'),
		('st-hl', 5, 'next-collection/x.rsc', 'h5', 'i1', 'ok', 'highlight-no-hard-error', NULL,
			'[{"highlight":[["cmd",6]]}]', 'highlight-rle-v1', '{"aligned":true}')`);
	db.run(
		"INSERT INTO capture_inputs VALUES ('i1', '{\"truncated\":false,\"replacedCodeUnits\":0}')",
	);
	db.run(`INSERT INTO third_party_cases VALUES
		(4, 'e14', 'unary and binary forms', 0, 'a3a646f', 'cases.json',
			'RouterOS 7.21.4 /import verbose=yes dry-run', 0, 'h4', '{}')`);
	return db;
}

describe("corpus-db readers (#498)", () => {
	test("a pre-schema-5 snapshot is refused with the repin in the message", () => {
		expect(() => requireCorpusSchema(corpus(4))).toThrow(/--repin/);
	});

	test("the population leaves out the auxiliary collections, in path order", () => {
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

	test("parse observations skip auxiliary collections, and a failed capture has no readout", () => {
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
		const [, row] = highlightObservations(corpus(), "st-hl");
		expect(row?.pairs).toEqual([
			[":", "dir"],
			["put", "cmd"],
			[" 1", "none"],
		]);
		expect(row?.aligned).toBe(true);
	});

	// Membership is the view's, by script id. A path-prefix filter names the
	// collections it knows, so `next-collection` stands in for whatever upstream
	// adds after `wiresage-conformance` (#42 leaked 875 rows that way).
	test("observations follow v_corpus_population, not a list of path prefixes", () => {
		const db = corpus();
		expect(parseObservations(db, ["st-parse"]).map((r) => r.scriptId)).toEqual([
			2, 1,
		]);
		expect(highlightObservations(db, "st-hl").map((r) => r.path)).toEqual([
			"a.rsc",
			"b.rsc",
		]);
	});

	test("a collection scope reads only that collection's observations", () => {
		expect(
			parseObservations(corpus(), ["st-parse"], {
				collection: CONFORMANCE_COLLECTION,
			}).map((r) => [r.path, r.responseClass]),
		).toEqual([["wiresage-conformance/e/e14.rsc", "plain-diagnostic"]]);
		expect(() =>
			parseObservations(corpus(), ["st-parse"], { collection: "absent" }),
		).toThrow(/collection `absent`/);
	});

	test("conformance cases carry the upstream label beside their bytes", () => {
		expect(conformanceCases(corpus())).toEqual([
			{
				scriptId: 4,
				path: "wiresage-conformance/e/e14.rsc",
				text: ":put ()",
				upstreamId: "e14",
				upstreamSection: "unary and binary forms",
				upstreamValid: false,
				upstreamRevision: "a3a646f",
				upstreamOracle: "RouterOS 7.21.4 /import verbose=yes dry-run",
			},
		]);
	});

	test("a conformance label recorded for other bytes is refused", () => {
		const db = corpus();
		db.run("UPDATE third_party_cases SET source_sha256 = 'other'");
		expect(() => conformanceCases(db)).toThrow(
			/recorded with source sha256 other/,
		);
		db.run("DELETE FROM third_party_cases");
		expect(() => conformanceCases(db)).toThrow(/predates lsp-routeros-ts#42/);
	});

	test("a misaligned row is reported without pairs, not thrown on", () => {
		// `a.rsc` is 2 characters and its stream claims 5: a desync. Decoding it
		// would throw and hide every other row of the run.
		const [row] = highlightObservations(corpus(), "st-hl");
		expect(row?.path).toBe("a.rsc");
		expect([row?.acquired, row?.aligned, row?.pairs]).toEqual([
			true,
			false,
			undefined,
		]);
	});

	test("an unknown response class is refused, not read as a reject", () => {
		const db = corpus();
		db.run(
			"UPDATE capture_observations SET response_class = 'new-class' WHERE script_id = 1 AND run_id = 'st-parse'",
		);
		expect(() => parseObservations(db, ["st-parse"])).toThrow(/new-class/);
	});

	test("a session whose runs record another version is refused", () => {
		const db = corpus();
		db.run(
			"UPDATE capture_runs SET routeros_version = '7.99' WHERE id = 'st-hl'",
		);
		expect(() => channelSessions(db)).toThrow(/st-hl records 7\.99/);
	});

	test("a highlight stream that does not cover the text exactly is refused", () => {
		expect(() => decodeHighlightRuns([["cmd", 2]], "abc")).toThrow(/2 of 3/);
		expect(() => decodeHighlightRuns([["cmd", 4]], "abc")).toThrow(/overrun/);
	});

	// Every collection the view leaves out is counted, including one this
	// reader has never heard of, and nothing the view keeps is.
	test("provenance counts the rows the view excludes, by collection", () => {
		const dir = mkdtempSync(join(tmpdir(), "corpus-db-"));
		try {
			const dbPath = join(dir, "corpus.sqlite");
			writeFileSync(dbPath, "x");
			expect(corpusProvenance(corpus(), dbPath)).toEqual({
				snapshot: "2d711642b726",
				excluded: {
					"capture-controls": 1,
					"next-collection": 1,
					"wiresage-conformance": 1,
				},
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the README clause states the snapshot and each excluded collection", () => {
		const excluded = { "capture-controls": 7, "wiresage-conformance": 875 };
		expect(describePopulation({ snapshot: "e12d5d4e58a4", excluded })).toBe(
			" of corpus snapshot `e12d5d4e58a4`, with 882 auxiliary rows " +
				"(7 `capture-controls`, 875 `wiresage-conformance`) excluded",
		);
		expect(describeExcluded({ "capture-controls": 7 })).toBe(
			"7 auxiliary rows (7 `capture-controls`)",
		);
		expect(describePopulation({})).toBe("");
	});
});
