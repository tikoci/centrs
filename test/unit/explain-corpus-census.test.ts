import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	BASELINE_TOTAL,
	type CorpusRow,
	census,
	defaultDbPath,
	flag,
	MARKERS,
	renderMarkdown,
} from "../../scripts/explain-corpus-census.ts";

function row(text: string, opts: Partial<CorpusRow> = {}): CorpusRow {
	return {
		path: opts.path ?? "test.rsc",
		collection: opts.collection ?? "test",
		text,
		hasCliPrompt: opts.hasCliPrompt ?? false,
	};
}

function markerTest(key: string): (row: CorpusRow) => boolean {
	const marker = MARKERS.find((m) => m.key === key);
	if (!marker) throw new Error(`no such marker: ${key}`);
	return marker.test;
}

describe("explain corpus census markers", () => {
	test("harness-header only trips on the injected first line, not a mid-file mention", () => {
		const test_ = markerTest("harness-header");
		expect(
			test_(row("# Source: https://forum.mikrotik.com/t/12345\n/ip/address")),
		).toBe(true);
		expect(
			test_(row("/ip/address\n# Source: https://forum.mikrotik.com/t/12345")),
		).toBe(false);
		expect(test_(row("/ip/address print"))).toBe(false);
	});

	test("scripting-directives matches the nine core keywords, not incidental colons", () => {
		const test_ = markerTest("scripting-directives");
		expect(test_(row(":local x 1"))).toBe(true);
		expect(test_(row(":if ($x = 1) do={ :put yes }"))).toBe(true);
		expect(test_(row("/ip/address add address=1.2.3.4/24"))).toBe(false);
		// ":put" alone is not in the core set that reproduces the #203 figure.
		expect(test_(row(":put hello"))).toBe(false);
	});

	test("line-continuation requires a trailing backslash immediately before EOL", () => {
		const test_ = markerTest("line-continuation");
		expect(test_(row("add address=1.2.3.4/24 \\\n  comment=x"))).toBe(true);
		expect(test_(row("add address=1.2.3.4/24 comment=x\\y"))).toBe(false);
	});

	test("export-idiom requires the add/set to actually follow the menu line", () => {
		const test_ = markerTest("export-idiom");
		expect(test_(row("/ip/address\nadd address=1.2.3.4/24"))).toBe(true);
		expect(test_(row("/ip address\nadd address=1.2.3.4/24"))).toBe(true);
		// Blank lines and comments between the two do not break the idiom.
		expect(test_(row("/ip/address\n\n# note\nadd address=1.2.3.4/24"))).toBe(
			true,
		);
		// Both conditions present but unordered is NOT the idiom: this is the
		// reading that inflated the first cut of the #203 table from 37 to 40.
		expect(test_(row("add address=1.2.3.4/24\n:put x\n/system clock"))).toBe(
			false,
		);
		// Indented pastes are not device-emitted export shape.
		expect(test_(row("  /ip/address\n  add address=1.2.3.4/24"))).toBe(false);
		expect(test_(row("add address=1.2.3.4/24"))).toBe(false);
		expect(test_(row("/ip/address print"))).toBe(false);
		// A slash-led *command* is not a menu line, so what follows it is not
		// the export idiom — leading `/` and no `=` is not enough to call a
		// line navigation.
		expect(test_(row("/system resource print\nadd name=x"))).toBe(false);
		expect(test_(row("/system script run\nadd name=x"))).toBe(false);
	});

	test("pure-config ignores hex-colon literals, which are not scripting directives", () => {
		const test_ = markerTest("pure-config");
		expect(test_(row("/ip/address\nadd address=1.2.3.4/24"))).toBe(true);
		// The three literal families the first cut misread as `:` directives —
		// the systematic under-count of the config genre #203 is about.
		expect(
			test_(row("/interface/bridge/host\nadd mac-address=02:23:06:EB:D1:A5")),
		).toBe(true);
		expect(test_(row("/ipv6/address\nadd address=2001:db8::a/64"))).toBe(true);
		expect(
			test_(row("/ip/dhcp-server/lease\nadd client-id=1:c0:25:67:99:a3")),
		).toBe(true);
		// A colon inside an ordinary value is not a directive — and position
		// alone cannot see that, because inside quotes `comment=":allow"` and
		// `source=":put x"` are the same shape. Only the key separates them.
		expect(
			test_(row('/ip firewall filter\nadd chain=input comment="policy:allow"')),
		).toBe(true);
		expect(test_(row('add chain=input comment=":allow"'))).toBe(true);
		expect(test_(row('add chain=input comment="policy :allow"'))).toBe(true);
		expect(test_(row('/system note\nset note="see http://wiki/x"'))).toBe(true);
		// Real scripting still excludes the file, including inside a string
		// under a key that genuinely carries script text.
		expect(test_(row(":local x 1\nadd address=1.2.3.4/24"))).toBe(false);
		expect(test_(row(":put [:len $x]\nadd address=1.2.3.4/24"))).toBe(false);
		expect(test_(row('add source=":put hello"'))).toBe(false);
		// Every RouterOS script hook, not just the handful an earlier closed
		// list happened to name. All of these appear in the corpus.
		for (const key of [
			"script",
			"up-script",
			"down-script",
			"test-script",
			"lease-script",
			"on-event",
			"on-error",
			"on-boot",
			"on-login",
			"on-logout",
			"on-master",
			"on-backup",
			"on-message",
			"on-up",
			"on-down",
		]) {
			expect(test_(row(`add host=1.1.1.1 ${key}=":put x"`))).toBe(false);
		}
		// Ordinary keys that merely resemble them stay opaque.
		expect(test_(row('add name=x comment="on-call:24x7"'))).toBe(true);
		expect(test_(row('add description="script:v2"'))).toBe(true);
		expect(test_(row("add x=1; :put done"))).toBe(false);
		expect(test_(row("/ip/address print"))).toBe(false);
	});

	test("terse-statement sees the one-line export shape the other config markers miss", () => {
		const test_ = markerTest("terse-statement");
		expect(test_(row("/ip address add address=192.168.88.1/24"))).toBe(true);
		expect(test_(row("/port set 0 name=serial0"))).toBe(true);
		expect(test_(row("/ip/firewall/filter add chain=forward"))).toBe(true);
		// A bare menu line carries no verb; a print is not an export verb.
		expect(test_(row("/ip/address"))).toBe(false);
		expect(test_(row("/ip/address print"))).toBe(false);
		// The verb must precede the arguments, not appear inside a value.
		expect(test_(row("/ip/address comment=add"))).toBe(false);
		// The multi-line idiom is deliberately not a terse statement.
		expect(test_(row("/ip/address\nadd address=1.2.3.4/24"))).toBe(false);
	});

	test("a verb-shaped positional operand is not an export verb", () => {
		const terse = markerTest("terse-statement");
		const doc = markerTest("terse-export-doc");
		// `add` here is the *name of the script being run*, not a write verb —
		// scanning the whole line for a verb-looking token would read this as an
		// export statement and inflate the export strata.
		expect(terse(row("/system script run add"))).toBe(false);
		expect(doc(row("/system script run add"))).toBe(false);
		expect(terse(row("/system script run set"))).toBe(false);
		// A command claims the line even when a verb-shaped word follows later.
		expect(terse(row("/ip firewall filter print add"))).toBe(false);
		// The genuine shape still registers.
		expect(terse(row("/system script add name=add source=x"))).toBe(true);
	});

	test("RouterOS separator spellings tokenize identically", () => {
		const terse = markerTest("terse-statement");
		const doc = markerTest("terse-export-doc");
		const idiom = markerTest("export-idiom");
		// `/` and whitespace are interchangeable separators, so a command word
		// hidden inside a slash-joined path must still end the path. Splitting on
		// whitespace alone sees `/system/script/run` as one opaque token.
		for (const line of [
			"/system script run add",
			"/system/script/run add",
			"/system script/run add",
			"/system/script run add",
		]) {
			expect(terse(row(line))).toBe(false);
			expect(doc(row(line))).toBe(false);
		}
		for (const menu of [
			"/system resource print",
			"/system/resource/print",
			"/system resource/print",
			"/system/resource print",
		]) {
			expect(idiom(row(`${menu}\nadd name=x`))).toBe(false);
		}
		// And the genuine statement is recognized in every spelling, including
		// the fully slash-joined form the whitespace-only split used to miss.
		for (const line of [
			"/ip address add address=1.2.3.4/24",
			"/ip/address add address=1.2.3.4/24",
			"/ip/address/add address=1.2.3.4/24",
			"/file/add name=x",
		]) {
			expect(terse(row(line))).toBe(true);
		}
		// A slash inside an argument value is not a path separator.
		expect(terse(row("/ip/address add address=1.2.3.4/24"))).toBe(true);
		expect(terse(row("/ip/address"))).toBe(false);
	});

	test("terse-export-doc requires every statement to be a one-liner", () => {
		const test_ = markerTest("terse-export-doc");
		expect(
			test_(
				row(
					"# 1970-01-01 00:00:00 by RouterOS 7.15.3\n/port set 0 name=serial0\n/ip address add address=192.168.88.1/24\n",
				),
			),
		).toBe(true);
		// One multi-line-idiom statement disqualifies the document.
		expect(
			test_(
				row(
					"/ip address add address=1.2.3.4/24\n/ip/route\nadd gateway=1.2.3.1",
				),
			),
		).toBe(false);
		// A scripted section disqualifies it too.
		expect(test_(row("/ip address add address=1.2.3.4/24\n:put done"))).toBe(
			false,
		);
		// Comments alone are not a document.
		expect(test_(row("# just a comment\n"))).toBe(false);
	});

	test("eworm-shebang and export-banner are disjoint (the #203 conflation fix)", () => {
		const shebang = markerTest("eworm-shebang");
		const banner = markerTest("export-banner");
		const shebangRow = row("#!rsc by RouterOS 7.15.2\n/ip/address");
		const bannerRow = row(
			"# nov/14/2021 10:31:11 by RouterOS 7.1rc6\n/ip/address",
		);
		expect(shebang(shebangRow)).toBe(true);
		expect(banner(shebangRow)).toBe(false);
		expect(shebang(bannerRow)).toBe(false);
		expect(banner(bannerRow)).toBe(true);
	});

	test("script-in-string vs script-in-brace are distinct source= quoting styles", () => {
		const inString = markerTest("script-in-string");
		const inBrace = markerTest("script-in-brace");
		expect(inString(row('add source="/ip/address print"'))).toBe(true);
		expect(inBrace(row('add source="/ip/address print"'))).toBe(false);
		expect(inBrace(row("add source={ /ip/address print }"))).toBe(true);
		expect(inString(row("add source={ /ip/address print }"))).toBe(false);
	});

	test("markers added after #203 carry no baseline to compare against", () => {
		const withoutBaseline = MARKERS.filter((m) => m.baseline === undefined).map(
			(m) => m.key,
		);
		expect(withoutBaseline).toEqual(["terse-statement", "terse-export-doc"]);
	});
});

describe("census aggregation", () => {
	test("tallies collections and markers independently, in descending collection order", () => {
		const rows: CorpusRow[] = [
			row("/ip/address\nadd address=1.2.3.4/24", { collection: "a" }),
			row(":local x 1", { collection: "a" }),
			row("add address=5.6.7.8/24", { collection: "b" }),
		];
		const result = census(rows);
		expect(result.total).toBe(3);
		expect(result.baselineTotal).toBe(BASELINE_TOTAL);
		expect(result.byCollection).toEqual([
			{ collection: "a", files: 2 },
			{ collection: "b", files: 1 },
		]);
		const exportIdiom = result.byMarker.find((m) => m.key === "export-idiom");
		expect(exportIdiom?.files).toBe(1);
		const directives = result.byMarker.find(
			(m) => m.key === "scripting-directives",
		);
		expect(directives?.files).toBe(1);
	});

	test("every marker carries a per-collection stratum, zeros included", () => {
		const rows: CorpusRow[] = [
			row("/ip address add address=1.2.3.4/24", { collection: "exports" }),
			row(":local x 1", { collection: "scripts" }),
		];
		const result = census(rows);
		const terse = result.byMarker.find((m) => m.key === "terse-statement");
		expect(terse?.byCollection).toEqual({ exports: 1, scripts: 0 });
		const directives = result.byMarker.find(
			(m) => m.key === "scripting-directives",
		);
		expect(directives?.byCollection).toEqual({ exports: 0, scripts: 1 });
	});

	test("renderMarkdown emits collection, marker, and stratum tables", () => {
		const result = census([row("/ip/address\nadd address=1.2.3.4/24")]);
		const md = renderMarkdown(result, { compare: false });
		expect(md).toContain("## By collection");
		expect(md).toContain("## By genre marker");
		expect(md).toContain("## Genre marker by collection");
		expect(md).not.toContain("#203 baseline");
	});

	test("--db without a value is a usage error, not a silent fallback", () => {
		expect(flag(["--db", "/tmp/corpus.sqlite"], "--db")).toBe(
			"/tmp/corpus.sqlite",
		);
		expect(flag(["--json"], "--db")).toBeUndefined();
		// Would otherwise open a file named "--json" and report a missing corpus.
		expect(() => flag(["--db", "--json"], "--db")).toThrow(
			"--db requires a value",
		);
		expect(() => flag(["--compare", "--db"], "--db")).toThrow(
			"--db requires a value",
		);
		// Single-dash options are options too.
		expect(() => flag(["--db", "-x"], "--db")).toThrow("--db requires a value");
		// A relative path is a perfectly good value.
		expect(flag(["--db", "./corpus.sqlite"], "--db")).toBe("./corpus.sqlite");
	});

	test("the corpus resolves as a sibling of this checkout, not from $HOME", () => {
		const previous = Bun.env["CENTRS_CORPUS_DB"];
		delete Bun.env["CENTRS_CORPUS_DB"];
		try {
			// test/unit/ -> repo root -> the directory holding both checkouts.
			const siblingRoot = resolve(import.meta.dir, "../..", "..");
			expect(defaultDbPath()).toBe(
				resolve(siblingRoot, "lsp-routeros-ts/test-data/corpus.sqlite"),
			);
			Bun.env["CENTRS_CORPUS_DB"] = "/elsewhere/corpus.sqlite";
			expect(defaultDbPath()).toBe("/elsewhere/corpus.sqlite");
		} finally {
			if (previous === undefined) delete Bun.env["CENTRS_CORPUS_DB"];
			else Bun.env["CENTRS_CORPUS_DB"] = previous;
		}
	});

	test("renderMarkdown --compare adds baseline/delta columns and a size caveat", () => {
		const result = census([row("/ip/address\nadd address=1.2.3.4/24")]);
		const md = renderMarkdown(result, { compare: true });
		expect(md).toContain("#203 baseline");
		expect(md).toContain("Delta");
		// 1 row != the 913-script baseline corpus, so the caveat must appear.
		expect(md).toContain("mix marker drift with");
	});
});
