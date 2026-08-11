/**
 * Anchor tests for the corpus pin (#186).
 *
 * These deliberately do not touch the network or require the corpus to be
 * present: the value of a pin is that its *shape* is checkable offline. What is
 * asserted is the part that silently rots — a ref that is not a commit, a
 * mistyped hash, a cache key that stops tracking the hash, and the precedence
 * that decides which corpus a figure actually came from.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acceptCachedCorpus,
	type CorpusPin,
	cachePath,
	describeResolution,
	pinUrl,
	readPin,
	resolveCorpusDb,
	sha256File,
	unreachableMessage,
} from "../../scripts/corpus-fetch.ts";

function withEnv<T>(value: string | undefined, run: () => T): T {
	const previous = Bun.env["CENTRS_CORPUS_DB"];
	if (value === undefined) delete Bun.env["CENTRS_CORPUS_DB"];
	else Bun.env["CENTRS_CORPUS_DB"] = value;
	try {
		return run();
	} finally {
		if (previous === undefined) delete Bun.env["CENTRS_CORPUS_DB"];
		else Bun.env["CENTRS_CORPUS_DB"] = previous;
	}
}

describe("corpus pin", () => {
	test("the committed pin is well formed", () => {
		const pin = readPin();
		expect(pin.repo).toBe("tikoci/lsp-routeros-ts");
		expect(pin.path).toBe("test-data/corpus.sqlite");
		expect(pin.ref).toMatch(/^[0-9a-f]{40}$/);
		expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(pin.bytes).toBeGreaterThan(0);
		expect(pin.scripts).toBeGreaterThan(0);
	});

	test("the URL is the raw blob at the pinned commit", () => {
		const pin = readPin();
		expect(pinUrl(pin)).toBe(
			`https://raw.githubusercontent.com/tikoci/lsp-routeros-ts/${pin.ref}/test-data/corpus.sqlite`,
		);
		// A ref-less or branch URL would let the pinned bytes move under the pin.
		expect(pinUrl(pin)).not.toContain("/main/");
	});

	test("the cache path tracks the hash, so a repin cannot reuse a stale entry", () => {
		const pin = readPin();
		const other: CorpusPin = { ...pin, sha256: `f${pin.sha256.slice(1)}` };
		expect(cachePath(pin)).toContain(pin.sha256.slice(0, 12));
		expect(cachePath(other)).not.toBe(cachePath(pin));
	});
});

describe("corpus resolution", () => {
	test("an explicit --db path wins over everything", () => {
		withEnv("/env/corpus.sqlite", () => {
			const r = resolveCorpusDb("/flag/corpus.sqlite");
			expect(r.path).toBe("/flag/corpus.sqlite");
			expect(r.source).toBe("flag");
			// An explicit path is never second-guessed against the pin.
			expect(r.warning).toBeUndefined();
		});
	});

	test("CENTRS_CORPUS_DB wins over the automatic sources", () => {
		withEnv("/env/corpus.sqlite", () => {
			const r = resolveCorpusDb();
			expect(r.path).toBe("/env/corpus.sqlite");
			expect(r.source).toBe("env");
		});
	});

	test("without an override the source is named, or nothing is reachable", () => {
		withEnv(undefined, () => {
			const r = resolveCorpusDb();
			// Environment-dependent by design: a dev machine has the sibling
			// checkout, CI has only the fetched cache, a bare clone has neither.
			// What must hold everywhere is that the answer is self-describing.
			if (r.path === undefined) {
				expect(r.source).toBeUndefined();
			} else {
				expect(["sibling", "cache"]).toContain(r.source ?? "");
				expect(r.sha256 ?? "").toMatch(/^[0-9a-f]{64}$/);
			}
		});
	});

	test("a reported hash is one that was actually computed", () => {
		// Whatever source resolves here, it must not report a hash it did not
		// compute. Passes vacuously where nothing resolves, so the corrupt-cache
		// case is pinned directly below rather than through this.
		withEnv(undefined, () => {
			const r = resolveCorpusDb();
			if (r.path === undefined || r.sha256 === undefined) return;
			expect(r.sha256).toBe(sha256File(r.path));
		});
	});

	test("a cache entry whose bytes miss the pin does not resolve", () => {
		// The defect this pins: the cache branch returned `pin.sha256` for a file
		// it never hashed, so a corrupt or swapped entry was measured and
		// reported under a hash its bytes had never been checked against.
		//
		// Driven directly rather than through `resolveCorpusDb`, which reaches
		// the cache branch only when a sibling checkout is absent AND a cache
		// entry is present — true on a CI runner mid-job, but on no job we run,
		// so a test routed through it would pass by not executing.
		const dir = mkdtempSync(join(tmpdir(), "centrs-corpus-"));
		try {
			const entry = join(dir, "corpus-0accd1c08743.sqlite");
			writeFileSync(entry, "not the corpus");
			const pin = readPin();

			const rejected = acceptCachedCorpus(entry, pin);
			expect(rejected.path).toBeUndefined();
			expect(rejected.source).toBeUndefined();
			// Names the real hash and the way out, not just "no".
			expect(rejected.warning).toContain(sha256File(entry).slice(0, 12));
			expect(rejected.warning).toContain("corpus:fetch --force");

			// Same file, honest pin: accepted, and the hash is the computed one.
			const matching = acceptCachedCorpus(entry, {
				...pin,
				sha256: sha256File(entry),
			});
			expect(matching.path).toBe(entry);
			expect(matching.source).toBe("cache");
			expect(matching.sha256).toBe(sha256File(entry));
			expect(matching.warning).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a resolution describes itself with its source and hash", () => {
		const line = describeResolution({
			path: "/x/corpus.sqlite",
			source: "cache",
			sha256:
				"0accd1c087431cfcc54369c34b84e1645f41bbbfdcded5892713d9112ccd9daa",
		});
		expect(line).toBe("corpus: /x/corpus.sqlite (cache sha256:0accd1c08743)");
	});

	test("the unreachable message names all three ways out", () => {
		const message = unreachableMessage("explain value census");
		expect(message).toStartWith("::error title=explain value census::");
		expect(message).toContain("bun run corpus:fetch");
		expect(message).toContain("sibling checkout");
		expect(message).toContain("--db");
	});
});
