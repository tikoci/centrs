#!/usr/bin/env bun
/**
 * Reach the RouterOS script corpus the `explain` censuses read (issue #186).
 *
 * The corpus is `tikoci/lsp-routeros-ts`'s `test-data/corpus.sqlite` — 948
 * scripts, schema v3, built there by `scripts/build-corpus-db.ts`. It does not
 * live here and is not moving here: a 10 MB binary SQLite is unreadable in a
 * web review either way, and it carries third-party script text (one GPL
 * collection, one with no grant at all) that has no business inside centrs's
 * licensed surface.
 *
 * The ownership boundary that settles it: **`lsp-routeros-ts` owns producing
 * snapshots; centrs owns which snapshot it measures against.** That second half
 * is what `corpus-pin.json` is — a repo, a 40-hex commit, and the sha256 of the
 * blob at that commit. Before this script the answer was "whatever happens to
 * be checked out next to your clone", which is why both censuses ran on exactly
 * one machine and never in CI (#260 ran into the same wall).
 *
 * That repo is public and the DB is git-tracked, so the snapshot is one HTTPS
 * GET from `raw.githubusercontent.com` away. No API token, no LFS.
 *
 * ## Resolution order
 *
 * 1. `--db PATH` — an explicit path is never second-guessed.
 * 2. `CENTRS_CORPUS_DB` — same, for CI and one-off runs.
 * 3. A **sibling checkout** at `../../lsp-routeros-ts/test-data/corpus.sqlite`,
 *    resolved from this file so any clone layout works. Preserved as the first
 *    automatic source because it is the existing local workflow and the only
 *    way to measure a snapshot that has not been pinned yet.
 * 4. The **pinned cache** written by `bun run corpus:fetch`.
 *
 * A sibling checkout is hashed and compared against the pin on every run. It
 * disagreeing is not an error — that is what iterating on a new snapshot looks
 * like — but it is *announced*, with both hashes, because a local number that
 * silently came from a different corpus than CI's is the drift #260 exists to
 * catch. Every census prints the source and hash it actually used.
 *
 * A **downloaded** file that misses the pin is a hard error. Re-downloading
 * until something matches, or accepting what arrives, would make the pin
 * decorative.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fetchBytesWithRetry } from "./fetch-retry.ts";

/** The pinned snapshot, as recorded in `corpus-pin.json`. */
export interface CorpusPin {
	/** `owner/name` of the repository holding the snapshot. */
	readonly repo: string;
	/** A 40-hex commit. A branch name would make the pin non-reproducible. */
	readonly ref: string;
	/** Path to the blob within that commit. */
	readonly path: string;
	/** sha256 of the blob, lowercase hex. The pin proper. */
	readonly sha256: string;
	/** Byte length, checked before hashing so a truncated body says so. */
	readonly bytes: number;
	/** `corpus_metadata.schema_version` of the pinned DB, for the record. */
	readonly schemaVersion: number;
	/** `count(*)` of `source_scripts`, for the record. */
	readonly scripts: number;
}

/** Where the resolved corpus came from. Reported so a figure is traceable. */
export type CorpusSource = "flag" | "env" | "sibling" | "cache";

export interface CorpusResolution {
	/** Absolute path to a corpus DB, or `undefined` when none is reachable. */
	readonly path: string | undefined;
	readonly source: CorpusSource | undefined;
	/** sha256 of `path`, computed for the automatic sources only. */
	readonly sha256?: string;
	/** Set when the resolved file is not the pinned snapshot. */
	readonly warning?: string;
}

const PIN_FILE = resolve(import.meta.dir, "corpus-pin.json");
/**
 * Resolved from this file rather than from `$HOME/GitHub`, so any clone layout
 * works as long as the two repos are siblings. Exported so a test can pin the
 * layout rule without depending on the checkout existing.
 */
export const SIBLING_CORPUS_DB = resolve(
	import.meta.dir,
	"../../lsp-routeros-ts/test-data/corpus.sqlite",
);
const CACHE_DIR = resolve(import.meta.dir, "../.cache/corpus");
/** 10 MB over a cold CI link needs more room than the 30 s text default. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

export function readPin(): CorpusPin {
	const pin = JSON.parse(readFileSync(PIN_FILE, "utf8")) as CorpusPin;
	if (!/^[0-9a-f]{40}$/.test(pin.ref)) {
		throw new Error(
			`corpus-pin.json: ref must be a 40-hex commit, got ${JSON.stringify(pin.ref)}`,
		);
	}
	if (!/^[0-9a-f]{64}$/.test(pin.sha256)) {
		throw new Error(
			`corpus-pin.json: sha256 must be 64-hex, got ${JSON.stringify(pin.sha256)}`,
		);
	}
	return pin;
}

export function pinUrl(pin: CorpusPin): string {
	return `https://raw.githubusercontent.com/${pin.repo}/${pin.ref}/${pin.path}`;
}

/**
 * Content-addressed, so a repin lands beside the old snapshot instead of
 * overwriting it. Note the CI cache keys on the *whole* pin file, not this
 * hash, and `fetchPinned` re-hashes whatever it finds either way.
 */
export function cachePath(pin: CorpusPin): string {
	return resolve(CACHE_DIR, `corpus-${pin.sha256.slice(0, 12)}.sqlite`);
}

export function sha256File(path: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(readFileSync(path))
		.digest("hex");
}

/**
 * Resolve a corpus DB without touching the network. `explicit` is a `--db`
 * value; `undefined` falls through to the env var, the sibling, then the cache.
 */
export function resolveCorpusDb(explicit?: string): CorpusResolution {
	if (explicit) return { path: explicit, source: "flag" };
	const env = Bun.env["CENTRS_CORPUS_DB"];
	if (env) return { path: env, source: "env" };

	const pin = readPin();
	if (existsSync(SIBLING_CORPUS_DB)) {
		const sha256 = sha256File(SIBLING_CORPUS_DB);
		return {
			path: SIBLING_CORPUS_DB,
			source: "sibling",
			sha256,
			warning:
				sha256 === pin.sha256
					? undefined
					: `sibling checkout is not the pinned snapshot (have ${sha256.slice(0, 12)}, pinned ${pin.sha256.slice(0, 12)}). ` +
						"Figures from this run are not comparable to CI's. Either repin " +
						"deliberately (`bun run corpus:fetch --repin <commit>`) or measure " +
						`the pinned copy (\`bun run corpus:fetch\`, then \`--db ${cachePath(pin)}\`).`,
		};
	}

	const cached = cachePath(pin);
	if (existsSync(cached)) return acceptCachedCorpus(cached, pin);
	return { path: undefined, source: undefined };
}

/**
 * Decide whether a cache entry may be measured from.
 *
 * Hashed, never assumed: the cache path is content-addressed by NAME, so taking
 * the pin's hash on faith would report a hash these bytes were never checked
 * against — the exact laundering this module exists to prevent, and asymmetric
 * with the sibling branch, which does hash.
 *
 * Unlike a sibling checkout, the cache is ours and is *supposed* to be the pin,
 * so a mismatch is corruption or tampering rather than someone iterating on a
 * new snapshot: it does not resolve at all.
 *
 * Split out as its own function so this is testable on any machine. Driving it
 * through `resolveCorpusDb` only reaches here when a sibling checkout is absent
 * AND a cache entry is present, which is true on no CI job we run.
 */
export function acceptCachedCorpus(
	cached: string,
	pin: CorpusPin,
): CorpusResolution {
	const sha256 = sha256File(cached);
	if (sha256 === pin.sha256) return { path: cached, source: "cache", sha256 };
	return {
		path: undefined,
		source: undefined,
		warning:
			`the cached corpus at ${cached} has sha256 ${sha256.slice(0, 12)}, ` +
			`not the pinned ${pin.sha256.slice(0, 12)}. Re-fetch it with ` +
			"`bun run corpus:fetch --force`.",
	};
}

/** The one-line "where did this number come from" note every census prints. */
export function describeResolution(r: CorpusResolution): string {
	const hash = r.sha256 ? ` sha256:${r.sha256.slice(0, 12)}` : "";
	return `corpus: ${r.path} (${r.source}${hash})`;
}

/** What a census prints when nothing is reachable. Actionable, per #186. */
export function unreachableMessage(title: string): string {
	return (
		`::error title=${title}::corpus.sqlite is not reachable\n` +
		"Run `bun run corpus:fetch` to download the pinned snapshot, clone " +
		"tikoci/lsp-routeros-ts as a sibling checkout, or pass --db <path>."
	);
}

/**
 * Download the pinned snapshot into the cache. A byte-length or hash miss
 * throws with both values; nothing partial is left behind.
 */
export async function fetchPinned(
	pin: CorpusPin,
	options: { force?: boolean } = {},
): Promise<{ path: string; downloaded: boolean }> {
	const target = cachePath(pin);
	if (!options.force && existsSync(target)) {
		const have = sha256File(target);
		if (have === pin.sha256) return { path: target, downloaded: false };
		// A corrupt or half-written cache entry is recoverable; say so and redo.
		console.error(
			`cached ${target} has sha256 ${have}, expected ${pin.sha256} — re-downloading`,
		);
	}

	const url = pinUrl(pin);
	const bytes = await fetchBytesWithRetry(url, DOWNLOAD_TIMEOUT_MS);
	if (bytes.byteLength !== pin.bytes) {
		throw new Error(
			`${url}\n  expected ${pin.bytes} bytes, got ${bytes.byteLength}`,
		);
	}
	const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	if (sha256 !== pin.sha256) {
		throw new Error(
			`${url}\n  expected sha256 ${pin.sha256}\n  got      sha256 ${sha256}\n` +
				"The pin and the remote blob disagree. Do not re-run until you know why: " +
				"either corpus-pin.json is stale (repin deliberately) or the source moved.",
		);
	}

	mkdirSync(dirname(target), { recursive: true });
	const staging = `${target}.tmp-${process.pid}`;
	try {
		await Bun.write(staging, bytes);
		renameSync(staging, target);
	} finally {
		rmSync(staging, { force: true });
	}
	return { path: target, downloaded: true };
}

/** Read the two facts the pin records for the record, from the DB itself. */
async function readDbFacts(
	path: string,
): Promise<{ schemaVersion: number; scripts: number }> {
	const { Database } = await import("bun:sqlite");
	const db = new Database(path, { readonly: true });
	try {
		const version = db
			.query("SELECT value FROM corpus_metadata WHERE key = 'schema_version'")
			.get() as { value: string } | null;
		const count = db
			.query("SELECT count(*) AS c FROM source_scripts")
			.get() as {
			c: number;
		};
		return {
			schemaVersion: Number(version?.value ?? 0),
			scripts: count.c,
		};
	} finally {
		db.close();
	}
}

/**
 * Move the pin to `ref`. Deliberately a separate, explicit mode: a pin that
 * updates itself as a side effect of a normal run is not a pin.
 */
async function repin(ref: string): Promise<number> {
	if (!/^[0-9a-f]{40}$/.test(ref)) {
		console.error(
			`::error title=corpus fetch::--repin needs a 40-hex commit, got ${JSON.stringify(ref)}\n` +
				"A branch or tag would let the pinned bytes change under a fixed pin.",
		);
		return 1;
	}
	const current = readPin();
	const url = pinUrl({ ...current, ref });
	const bytes = await fetchBytesWithRetry(url, DOWNLOAD_TIMEOUT_MS);
	const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	const staged: CorpusPin = {
		...current,
		ref,
		sha256,
		bytes: bytes.byteLength,
		schemaVersion: current.schemaVersion,
		scripts: current.scripts,
	};

	// Staged then renamed, as in `fetchPinned`. Publishing to the
	// content-addressed path before `readDbFacts` has accepted the bytes would
	// leave a file whose NAME claims a hash it was never validated under, at the
	// exact path a later run resolves from.
	const target = cachePath(staged);
	mkdirSync(dirname(target), { recursive: true });
	const staging = `${target}.tmp-${process.pid}`;
	let facts: { schemaVersion: number; scripts: number };
	try {
		await Bun.write(staging, bytes);
		facts = await readDbFacts(staging);
		renameSync(staging, target);
	} finally {
		rmSync(staging, { force: true });
	}

	const next = JSON.parse(readFileSync(PIN_FILE, "utf8")) as Record<
		string,
		unknown
	>;
	next["ref"] = ref;
	next["sha256"] = sha256;
	next["bytes"] = bytes.byteLength;
	next["schemaVersion"] = facts.schemaVersion;
	next["scripts"] = facts.scripts;
	await Bun.write(PIN_FILE, `${JSON.stringify(next, null, "\t")}\n`);

	console.log(
		[
			`repinned ${current.repo}:${current.path}`,
			`  ref     ${current.ref} -> ${ref}`,
			`  sha256  ${current.sha256} -> ${sha256}`,
			`  bytes   ${current.bytes} -> ${bytes.byteLength}`,
			`  schema  ${current.schemaVersion} -> ${facts.schemaVersion}`,
			`  scripts ${current.scripts} -> ${facts.scripts}`,
			"",
			"Re-run the censuses and commit any figure that moved — the snapshot is",
			"the input to every number in commands/explain/README.md.",
		].join("\n"),
	);
	return 0;
}

function flag(args: readonly string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
}

export async function main(args: readonly string[]): Promise<number> {
	const repinRef = flag(args, "--repin");
	if (args.includes("--repin")) return await repin(repinRef ?? "");

	const pin = readPin();
	if (args.includes("--print-path")) {
		console.log(cachePath(pin));
		return 0;
	}

	const { path, downloaded } = await fetchPinned(pin, {
		force: args.includes("--force"),
	});
	console.log(
		downloaded
			? `fetched ${pinUrl(pin)}\n  -> ${path}\n  sha256 ${pin.sha256} verified`
			: `up to date: ${path} (sha256 ${pin.sha256.slice(0, 12)})`,
	);
	return 0;
}

if (import.meta.main) {
	main(Bun.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(
				`::error title=corpus fetch::${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		});
}
