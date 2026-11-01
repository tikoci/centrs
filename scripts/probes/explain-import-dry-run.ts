/**
 * Ground `/import verbose=yes dry-run` as a diagnostic technique (#520).
 *
 * Compares identical bytes across five surfaces — `:parse`, `highlight`,
 * plain import, verbose import, verbose dry-run — on throwaway CHRs (one
 * fresh machine per import variant, so pre-state cannot leak between them).
 * Every row records input hashes, the RouterOS version, probe arguments, raw
 * responses, timings, upload cost, and the observed device state afterwards.
 *
 * What this establishes (and what it does not): whether dry-run reports the
 * same errors as a real import, what it executes vs skips (observable
 * controls: firewall entries, the system identity), error multiplicity and
 * coordinates, and stop/continue behavior. It does not adopt any verdict as
 * an oracle and does not add import to live explain.
 *
 * Run: bun run explain:probe:import-dry-run [version] (default 7.24.5).
 * Captures land in `.scratch/explain-import-dry-run.v<version>.*.json`
 * (in-flight by design). The reviewed slice lives at
 * `test/fixtures/explain/import-dry-run.slice.json`.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openChr, probeOutputPath } from "./chr.ts";

const VERSION = Bun.argv[2] ?? "7.24.5";

interface CaseFile {
	name: string;
	bytes: string;
	intent: string;
}

const FILES: CaseFile[] = [
	{
		name: "good.rsc",
		intent:
			"two valid adds; plain/verbose must apply both, dry-run must apply neither",
		bytes: [
			"/ip firewall address-list add list=probe-520 address=192.0.2.1/32 comment=probe-520-a",
			"/ip firewall address-list add list=probe-520 address=198.51.100.7/32 comment=probe-520-b",
			"",
		].join("\n"),
	},
	{
		name: "mixed.rsc",
		intent:
			"valid, bad command, valid; fail-fast shape, error multiplicity and coordinates",
		bytes: [
			"/ip firewall address-list add list=probe-520 address=192.0.2.9/32 comment=probe-520-c",
			"this is not a command",
			"/ip firewall address-list add list=probe-520 address=203.0.113.4/32 comment=probe-520-d",
			"",
		].join("\n"),
	},
	{
		name: "side-fx.rsc",
		intent:
			"harmless observable controls for what dry-run executes vs skips: identity rename plus one add",
		bytes: [
			"/system identity set name=probe-520-side-fx",
			"/ip firewall address-list add list=probe-520 address=192.0.2.99/32 comment=probe-520-e",
			"",
		].join("\n"),
	},
];

interface Variant {
	label: string;
	command: (file: string) => string;
	applies: boolean;
}

const VARIANTS: Variant[] = [
	{
		label: "dry-run",
		command: (f) => `/import file-name=${f} verbose=yes dry-run`,
		applies: false,
	},
	{
		label: "verbose",
		command: (f) => `/import file-name=${f} verbose=yes`,
		applies: true,
	},
	{ label: "plain", command: (f) => `/import file-name=${f}`, applies: true },
];

/** RouterOS string literal: escape `\` and `"` only (matches src/execute.ts). */
function routerOsStringLiteral(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const sha256 = (s: string): string =>
	createHash("sha256").update(s, "utf8").digest("hex");

async function timed<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
	const start = Date.now();
	const value = await fn();
	return { value, ms: Date.now() - start };
}

async function main(): Promise<void> {
	// Stage the identical bytes once locally; every machine gets a verbatim
	// upload of the same files (upload cost measured separately below).
	const stage = await mkdtemp(join(tmpdir(), "centrs-520-"));
	try {
		const staged: { local: string; file: CaseFile; hash: string }[] = [];
		for (const file of FILES) {
			const local = join(stage, file.name);
			await writeFile(local, file.bytes, "utf8");
			staged.push({ local, file, hash: sha256(file.bytes) });
		}

		// Static baseline on one machine: :parse of the exact uploaded bytes
		// plus per-line highlight error classes. No import runs here.
		const baseline = await openChr({
			reuse: undefined,
			name: "centrs-520-baseline",
			version: VERSION,
		});
		try {
			const staticRows: Record<string, unknown>[] = [];
			for (const { local, file, hash } of staged) {
				const up = await timed(() => baseline.upload(local, file.name));
				const parse = await timed(() =>
					baseline.exec(`:put [:parse ${routerOsStringLiteral(file.bytes)}]`),
				);
				const lines = file.bytes.split("\n").filter((l) => l.length > 0);
				const highlights: Record<string, unknown>[] = [];
				for (const line of lines) {
					const res = await timed(() =>
						baseline.rest("/console/inspect", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ request: "highlight", input: line }),
						}),
					);
					const raw = JSON.stringify(res.value);
					highlights.push({
						input: line,
						sha256: sha256(line),
						errorBytes: (raw.match(/"error"/g) ?? []).length,
						rawBytes: raw.length,
						ms: res.ms,
					});
				}
				staticRows.push({
					file: file.name,
					intent: file.intent,
					sha256: hash,
					bytes: file.bytes.length,
					uploadMs: up.ms,
					parse: {
						output: ((parse.value as { output?: string }).output ?? "").slice(
							0,
							300,
						),
						ms: parse.ms,
					},
					highlights,
				});
			}
			await Bun.write(
				await probeOutputPath(`explain-import-dry-run.v${VERSION}.static.json`),
				`${JSON.stringify({ routerosVersion: VERSION, staticRows }, null, 2)}\n`,
			);
			console.log(`static baseline: ${staticRows.length} files recorded`);
		} finally {
			await baseline.remove();
		}

		// Import matrix: one fresh machine per (file, variant).
		let n = 0;
		for (const { local, file, hash } of staged) {
			for (const variant of VARIANTS) {
				n++;
				const chr = await openChr({
					reuse: undefined,
					name: `centrs-520-${n}`,
					version: VERSION,
				});
				try {
					const resource = (await chr.rest("/system/resource")) as Record<
						string,
						string
					>;
					const actual =
						resource["version"]?.trim().split(/\s+/)[0] ?? "unknown";
					const up = await timed(() => chr.upload(local, file.name));
					const cmd = variant.command(file.name);
					const imp = await timed(() => chr.exec(cmd));
					const state = await timed(() =>
						chr.exec("/ip firewall address-list print where list=probe-520"),
					);
					const identity = await timed(() =>
						chr.exec("/system identity print"),
					);
					const record = {
						routerosVersion: actual,
						requestedVersion: VERSION,
						file: file.name,
						intent: file.intent,
						sha256: hash,
						bytes: file.bytes.length,
						variant: variant.label,
						command: cmd,
						uploadMs: up.ms,
						importMs: imp.ms,
						importOutput: imp.value,
						stateMs: state.ms,
						stateOutput: state.value,
						identityOutput: identity.value,
						capturedAt: new Date().toISOString(),
					};
					await Bun.write(
						await probeOutputPath(
							`explain-import-dry-run.v${actual}.${file.name}.${variant.label}.json`,
						),
						`${JSON.stringify(record, null, 2)}\n`,
					);
					console.log(
						`OK ${file.name} ${variant.label} on ${actual} ` +
							`(import ${imp.ms}ms): ${JSON.stringify(imp.value)?.slice(0, 160)}`,
					);
				} finally {
					await chr.remove();
				}
			}
		}
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

await main();
