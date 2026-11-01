/**
 * Ground `/import verbose=yes dry-run` as a diagnostic technique (#520).
 *
 * Compares identical bytes across five surfaces — `:parse`, `highlight`,
 * plain import, verbose import, verbose dry-run — on throwaway CHRs (one
 * fresh machine per import variant, so pre-state cannot leak between them).
 * Every row records input hashes, the RouterOS version, probe arguments, raw
 * responses, timings, upload cost, and the observed device state afterwards.
 *
 * Two families of input. The syntax files (`mixed.rsc`) carry a fault the
 * parser sees. The apply-time files carry the #203 import blockers — a
 * duplicate, a builtin, a missing mandatory value — plus a missing object and
 * an out-of-enum value: statements `:parse` accepts that a real import can
 * still reject. Each one sits between two harmless address-list adds, so the
 * state readback shows exactly which lines applied.
 *
 * What this establishes (and what it does not): whether dry-run reports the
 * same errors as a real import, what it executes vs skips (observable
 * controls: firewall entries, the system identity), error multiplicity and
 * coordinates, and stop/continue behavior. It does not adopt any verdict as
 * an oracle and does not add import to live explain.
 *
 * Run: bun run explain:probe:import-dry-run [version] [file.rsc …]
 * (default 7.24.5, every file). Per-run captures land in `.scratch/`; a full
 * run also writes `.scratch/explain-import-dry-run.v<version>.slice.json`,
 * which is copied unedited to `test/fixtures/explain/import-dry-run.slice.json`.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routerOsStringLiteral } from "../../src/core/routeros-string.ts";
import { CentrsError } from "../../src/errors.ts";
import { classifyParseResult } from "../../src/protocols/mac-telnet-console.ts";
import { openChr, type ProbeChr, probeOutputPath } from "./chr.ts";

const VERSION = Bun.argv[2] ?? "7.24.5";
const ONLY = Bun.argv.slice(3);

interface CaseFile {
	name: string;
	bytes: string;
	intent: string;
}

const add = (address: string, tag: string) =>
	`/ip firewall address-list add list=probe-520 address=${address}/32 comment=probe-520-${tag}`;

const FILES: CaseFile[] = [
	{
		name: "good.rsc",
		intent:
			"two valid adds; plain/verbose must apply both, dry-run must apply neither",
		bytes: [add("192.0.2.1", "a"), add("198.51.100.7", "b"), ""].join("\n"),
	},
	{
		name: "mixed.rsc",
		intent:
			"valid, bad command, valid; fail-fast shape, error multiplicity and coordinates",
		bytes: [
			add("192.0.2.9", "c"),
			"this is not a command",
			add("203.0.113.4", "d"),
			"",
		].join("\n"),
	},
	{
		name: "side-fx.rsc",
		intent:
			"harmless observable controls for what dry-run executes vs skips: identity rename plus one add",
		bytes: [
			"/system identity set name=probe-520-side-fx",
			add("192.0.2.99", "e"),
			"",
		].join("\n"),
	},
	{
		name: "duplicate.rsc",
		intent:
			"line 2 repeats line 1: a duplicate only exists once line 1 has applied (#203 blocker 1 class)",
		bytes: [
			add("192.0.2.20", "f"),
			add("192.0.2.20", "f"),
			add("192.0.2.21", "g"),
			"",
		].join("\n"),
	},
	{
		name: "builtin.rsc",
		intent: "line 2 is #203 blocker 2 verbatim: set on the builtin `all` list",
		bytes: [
			add("192.0.2.30", "h"),
			'/interface list set [ find name=all ] comment="contains all interfaces" exclude="" include="" name=all',
			add("192.0.2.31", "i"),
			"",
		].join("\n"),
	},
	{
		name: "missing-value.rsc",
		intent:
			"line 2 is #203 blocker 3 verbatim: security=private without its passwords",
		bytes: [
			add("192.0.2.40", "j"),
			"/snmp community add addresses=0.0.0.0/0 name=canary-snmp-priv security=private",
			add("192.0.2.41", "k"),
			"",
		].join("\n"),
	},
	{
		name: "missing-object.rsc",
		intent: "line 2 names an interface that does not exist on the device",
		bytes: [
			add("192.0.2.50", "l"),
			"/interface ethernet set ether99 comment=probe-520",
			add("192.0.2.51", "m"),
			"",
		].join("\n"),
	},
	{
		name: "invalid-value.rsc",
		intent: "line 2 gives an enum property a value outside its enum",
		bytes: [
			add("192.0.2.60", "n"),
			"/ip firewall filter add chain=forward action=probe-520-bogus",
			add("192.0.2.61", "o"),
			"",
		].join("\n"),
	},
];

interface Variant {
	label: string;
	command: (file: string) => string;
}

const VARIANTS: Variant[] = [
	{
		label: "dry-run",
		command: (f) => `/import file-name=${f} verbose=yes dry-run`,
	},
	{ label: "verbose", command: (f) => `/import file-name=${f} verbose=yes` },
	{ label: "plain", command: (f) => `/import file-name=${f}` },
];

/** Read back after every import: everything any file's line 2 could touch. */
const STATE: Record<string, string> = {
	addressList: "/ip firewall address-list print where list=probe-520",
	identity: "/system identity print",
	interfaceListAll: "/interface list print detail where name=all",
	snmpCommunity: "/snmp community print where name=canary-snmp-priv",
	ether1Comment: "/interface ethernet print where comment=probe-520",
	forwardFilter: "/ip firewall filter print where chain=forward",
};

const sha256 = (s: string): string =>
	createHash("sha256").update(s, "utf8").digest("hex");

async function timed<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
	const start = Date.now();
	const value = await fn();
	return { value, ms: Date.now() - start };
}

const outputOf = (value: unknown): string =>
	(value as { output?: string }).output ?? "";

/** The production `:parse` gate's answer: "accepted" or its `validation/*` code. */
function parseVerdict(output: string, cli: string): string {
	try {
		classifyParseResult(output, cli, "rest-api");
		return "accepted";
	} catch (error) {
		if (!(error instanceof CentrsError)) throw error;
		return error.code;
	}
}

/**
 * `highlight` for one line. The record is ONE comma-separated per-byte class
 * string, so an `error` byte is found by splitting it — matching `"error"`
 * against the raw JSON never fires (see explain-import-blocker-validity.ts).
 */
async function highlightLine(chr: ProbeChr, line: string) {
	const res = await timed(
		() =>
			chr.rest("/console/inspect", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ request: "highlight", input: line }),
			}) as Promise<{ highlight?: string }[]>,
	);
	const perByte = Array.isArray(res.value)
		? res.value[0]?.highlight
		: undefined;
	if (!perByte)
		throw new Error(
			`no per-byte highlight classes for ${JSON.stringify(line)}: ${JSON.stringify(res.value).slice(0, 120)}`,
		);
	const classes = perByte.split(",");
	const errorBytes = classes.filter((c) => c === "error").length;
	return {
		input: line,
		highlight: errorBytes > 0 ? "flagged" : "clean",
		errorBytes,
		classBytes: classes.length,
		ms: res.ms,
	};
}

async function main(): Promise<void> {
	const files = ONLY.length
		? FILES.filter((f) => ONLY.includes(f.name))
		: FILES;
	if (files.length !== (ONLY.length || FILES.length))
		throw new Error(`unknown file in ${ONLY.join(" ")}`);

	// Stage the identical bytes once locally; every machine gets a verbatim
	// upload of the same files (upload cost measured separately below).
	const stage = await mkdtemp(join(tmpdir(), "centrs-520-"));
	try {
		const staged: { local: string; file: CaseFile; hash: string }[] = [];
		for (const file of files) {
			const local = join(stage, file.name);
			await writeFile(local, file.bytes, "utf8");
			staged.push({ local, file, hash: sha256(file.bytes) });
		}

		// Static baseline on one machine: `:parse` of the exact file bytes and
		// `highlight` per line. No import runs here.
		const statics: Record<string, unknown> = {};
		let baselineVersion = "unknown";
		const baseline = await openChr({
			reuse: undefined,
			name: "centrs-520-baseline",
			version: VERSION,
		});
		try {
			baselineVersion = await routerOsVersion(baseline);
			for (const { file } of staged) {
				const parse = await timed(() =>
					baseline.exec(`:put [:parse ${routerOsStringLiteral(file.bytes)}]`),
				);
				const highlight = [];
				for (const line of file.bytes.split("\n").filter((l) => l.length > 0))
					highlight.push(await highlightLine(baseline, line));
				statics[file.name] = {
					parse: {
						verdict: parseVerdict(outputOf(parse.value), file.bytes),
						output: outputOf(parse.value),
						ms: parse.ms,
					},
					highlight,
				};
			}
			await Bun.write(
				await probeOutputPath(
					`explain-import-dry-run.v${baselineVersion}.static.json`,
				),
				`${JSON.stringify({ routerosVersion: baselineVersion, statics }, null, 2)}\n`,
			);
			console.log(
				`static baseline on ${baselineVersion}: ${staged.length} files`,
			);
		} finally {
			await baseline.remove();
		}

		// Import matrix: one fresh machine per (file, variant).
		const runs: Record<string, unknown>[] = [];
		let n = 0;
		for (const { local, file } of staged) {
			for (const variant of VARIANTS) {
				n++;
				const chr = await openChr({
					reuse: undefined,
					name: `centrs-520-${n}`,
					version: VERSION,
				});
				try {
					const actual = await routerOsVersion(chr);
					if (actual !== baselineVersion)
						throw new Error(
							`version drift: baseline ${baselineVersion}, run ${actual}`,
						);
					const up = await timed(() => chr.upload(local, file.name));
					const cmd = variant.command(file.name);
					const imp = await timed(() => chr.exec(cmd));
					const state: Record<string, string> = {};
					for (const [key, command] of Object.entries(STATE))
						state[key] = outputOf(await chr.exec(command));
					const run = {
						file: file.name,
						variant: variant.label,
						command: cmd,
						via: (imp.value as { via?: string }).via ?? "unknown",
						uploadMs: up.ms,
						importMs: imp.ms,
						importOutput: outputOf(imp.value),
						state,
					};
					runs.push(run);
					await Bun.write(
						await probeOutputPath(
							`explain-import-dry-run.v${actual}.${file.name}.${variant.label}.json`,
						),
						`${JSON.stringify({ routerosVersion: actual, capturedAt: new Date().toISOString(), ...run }, null, 2)}\n`,
					);
					console.log(
						`OK ${file.name} ${variant.label} (import ${imp.ms}ms): ${JSON.stringify(run.importOutput).slice(0, 160)}`,
					);
				} finally {
					await chr.remove();
				}
			}
		}

		if (ONLY.length) return;
		const slice = {
			_source: `Written by \`bun run explain:probe:import-dry-run ${VERSION}\` (scripts/probes/explain-import-dry-run.ts) on stock CHR ${baselineVersion} x86, ${new Date().toISOString().slice(0, 10)}, and copied here unedited. One disposable quickchr CHR per import run, destroyed after; uploads were verbatim bytes. No router is needed to read this file.`,
			routerosVersion: baselineVersion,
			arch: "x86",
			files: FILES.map((f) => ({
				name: f.name,
				intent: f.intent,
				sha256: sha256(f.bytes),
				input: f.bytes,
			})),
			static: statics,
			runs,
		};
		const slicePath = await probeOutputPath(
			`explain-import-dry-run.v${baselineVersion}.slice.json`,
		);
		await Bun.write(slicePath, `${JSON.stringify(slice, null, "\t")}\n`);
		console.log(`slice: ${slicePath}`);
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

async function routerOsVersion(chr: ProbeChr): Promise<string> {
	const resource = (await chr.rest("/system/resource")) as Record<
		string,
		string
	>;
	return resource["version"]?.trim().split(/\s+/)[0] ?? "unknown";
}

await main();
