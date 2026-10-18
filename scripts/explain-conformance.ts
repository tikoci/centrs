#!/usr/bin/env bun
/**
 * Offline `explain` against the device on the `wiresage-conformance` cases.
 *
 * lsp-routeros-ts#42 captured the 875 wiresage/routeros-lsp grammar probes with
 * `:parse` on all four channel sessions. This census reads them through
 * `corpus-db.ts` and asks, per case, the question the execute gate asks:
 * `explainCommand(text).verdict === "fail"` is a refusal (`src/offline-gate.ts`
 * passes every `warn`). Against the device verdict that gives two lists, and
 * they are the work queue for #503–#507:
 *
 * - **false rejects**: offline `fail`, the device accepts on every channel.
 * - **missed rejections**: offline `pass`/`warn`, the device rejects on every
 *   channel.
 *
 * A case whose channels disagree is `split` and is listed on its own, never in
 * either list. The device answer is the corpus `response_class`, so only
 * `il-no-recognized-diagnostic` is an accept (`isAcceptedParse`).
 *
 * The upstream `valid` label is a third oracle (7.21.4, `/import … verbose=yes
 * dry-run`, per line). Where it disagrees with an all-channel device verdict
 * the case is listed under `upstreamDisagreements`, for #507. It is never
 * scored against.
 *
 * ```
 * bun run explain:conformance                     # markdown report
 * bun run explain:conformance --section express   # report, sections matching
 * bun run explain:conformance --json              # the fixture
 * bun run explain:conformance:check               # gate: fresh census vs fixture
 * ```
 *
 * A fix that moves a case moves the fixture, and the `--check` drift names the
 * case. Re-adopt with `bun run explain:conformance --json >
 * test/fixtures/explain/conformance.json` and say in the PR which cases moved.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { explainCommand } from "../src/explain.ts";
import {
	CONFORMANCE_COLLECTION,
	type ConformanceCase,
	channelSessions,
	conformanceCases,
	corpusProvenance,
	isAcceptedParse,
	parseObservations,
} from "./corpus-db.ts";
import {
	describeResolution,
	resolveCorpusDb,
	unreachableMessage,
} from "./corpus-fetch.ts";

const FIXTURE_PATH = join(
	import.meta.dir,
	"..",
	"test",
	"fixtures",
	"explain",
	"conformance.json",
);

export type DeviceVerdict = "accept" | "reject" | "split";

/** One case, joined: its bytes, the offline answer and every channel's. */
export interface ConformanceRow {
	path: string;
	section: string;
	text: string;
	upstreamValid: boolean;
	offline: "pass" | "warn" | "fail";
	/** Error-severity diagnostic codes, the reason for a `fail`. */
	failCodes: string[];
	/** channel → `response_class`. */
	device: Record<string, string>;
}

export interface ChannelFigures {
	version: string;
	parseRunId: string;
	accepted: number;
	rejected: number;
}

export interface ConformanceCensus {
	snapshot: string;
	cases: number;
	channels: Record<string, ChannelFigures>;
	offline: Record<"pass" | "warn" | "fail", number>;
	device: Record<DeviceVerdict, number>;
	/** path → the `fail` codes. */
	falseRejects: Record<string, string>;
	/** path → the offline verdict and the device classes. */
	missedRejections: Record<string, string>;
	/**
	 * Missed rejections by device class. `plain-diagnostic` is a syntax error
	 * offline could catch; `embedded-diagnostic` is mostly a menu or parameter
	 * name, which needs per-command argument lists (#501).
	 */
	missedByClass: Record<string, number>;
	/** path → `channel=class` for each channel. */
	split: Record<string, string>;
	/** path → `upstream valid|invalid, device accept|reject`. */
	upstreamDisagreements: Record<string, string>;
}

export function deviceVerdict(device: Record<string, string>): DeviceVerdict {
	const accepted = Object.values(device).map(isAcceptedParse);
	if (accepted.every(Boolean)) return "accept";
	if (accepted.some(Boolean)) return "split";
	return "reject";
}

function classes(device: Record<string, string>): string {
	return [...new Set(Object.values(device))].sort().join("|");
}

export function census(
	rows: readonly ConformanceRow[],
	channels: Record<string, ChannelFigures>,
	snapshot: string,
): ConformanceCensus {
	const result: ConformanceCensus = {
		snapshot,
		cases: rows.length,
		channels,
		offline: { pass: 0, warn: 0, fail: 0 },
		device: { accept: 0, reject: 0, split: 0 },
		falseRejects: {},
		missedRejections: {},
		missedByClass: {},
		split: {},
		upstreamDisagreements: {},
	};
	for (const row of rows) {
		result.offline[row.offline]++;
		const device = deviceVerdict(row.device);
		result.device[device]++;
		if (device === "split") {
			result.split[row.path] = Object.entries(row.device)
				.map(([channel, cls]) => `${channel}=${cls}`)
				.join(", ");
			continue;
		}
		if (device === "accept" && row.offline === "fail")
			result.falseRejects[row.path] = row.failCodes.join(", ");
		if (device === "reject" && row.offline !== "fail") {
			const cls = classes(row.device);
			result.missedRejections[row.path] = `${row.offline}; device ${cls}`;
			result.missedByClass[cls] = (result.missedByClass[cls] ?? 0) + 1;
		}
		if (row.upstreamValid !== (device === "accept"))
			result.upstreamDisagreements[row.path] =
				`upstream ${row.upstreamValid ? "valid" : "invalid"}, device ${device}`;
	}
	return result;
}

/** Each case's offline answer, by the gate's own call. */
export function offlineRow(
	item: ConformanceCase,
	device: Record<string, string>,
): ConformanceRow {
	const data = explainCommand(item.text);
	return {
		path: item.path,
		section: item.upstreamSection,
		text: item.text,
		upstreamValid: item.upstreamValid,
		offline: data.verdict,
		failCodes: [
			...new Set(
				data.diagnostics
					.filter((d) => d.severity === "error")
					.map((d) => d.code),
			),
		].sort(),
		device,
	};
}

function loadRows(dbPath: string): {
	rows: ConformanceRow[];
	channels: Record<string, ChannelFigures>;
	snapshot: string;
} {
	const db = new Database(dbPath, { readonly: true });
	try {
		const cases = conformanceCases(db);
		const sessions = channelSessions(db);
		const device = new Map<string, Record<string, string>>();
		const channels: Record<string, ChannelFigures> = {};
		for (const session of sessions) {
			const figures: ChannelFigures = {
				version: session.version,
				parseRunId: session.parseRunId,
				accepted: 0,
				rejected: 0,
			};
			for (const o of parseObservations(db, [session.parseRunId], {
				collection: CONFORMANCE_COLLECTION,
			})) {
				const byChannel = device.get(o.path) ?? {};
				byChannel[session.channel] = o.responseClass;
				device.set(o.path, byChannel);
				if (isAcceptedParse(o.responseClass)) figures.accepted++;
				else figures.rejected++;
			}
			channels[session.channel] = figures;
		}
		const rows = cases.map((item) => {
			const observed = device.get(item.path);
			// Every channel session must cover every case; upstream selects a
			// session only when it does, so a gap here is a reader bug.
			if (
				observed === undefined ||
				Object.keys(observed).length !== sessions.length
			)
				throw new Error(
					`${item.path} is not observed on every channel session`,
				);
			return offlineRow(item, observed);
		});
		return {
			rows,
			channels,
			snapshot: corpusProvenance(db, dbPath).snapshot,
		};
	} finally {
		db.close();
	}
}

/** Drift as lines a PR can quote: a moved figure, or a case in or out of a list. */
export function diffAgainstFixture(
	fresh: ConformanceCensus,
	pinned: ConformanceCensus,
): string[] {
	const drift: string[] = [];
	const scalar = (key: string, a: unknown, b: unknown) => {
		if (JSON.stringify(a) !== JSON.stringify(b))
			drift.push(
				`${key}: fixture ${JSON.stringify(b)}, measured ${JSON.stringify(a)}`,
			);
	};
	scalar("snapshot", fresh.snapshot, pinned.snapshot);
	scalar("cases", fresh.cases, pinned.cases);
	scalar("channels", fresh.channels, pinned.channels);
	scalar("offline", fresh.offline, pinned.offline);
	scalar("device", fresh.device, pinned.device);
	scalar("missedByClass", fresh.missedByClass, pinned.missedByClass);
	for (const key of [
		"falseRejects",
		"missedRejections",
		"split",
		"upstreamDisagreements",
	] as const) {
		const a = fresh[key];
		const b = pinned[key] ?? {};
		for (const path of [
			...new Set([...Object.keys(a), ...Object.keys(b)]),
		].sort()) {
			if (a[path] === b[path]) continue;
			if (b[path] === undefined) drift.push(`${key} + ${path} (${a[path]})`);
			else if (a[path] === undefined)
				drift.push(`${key} - ${path} (was ${b[path]})`);
			else drift.push(`${key} ~ ${path}: ${b[path]} -> ${a[path]}`);
		}
	}
	return drift;
}

function shown(text: string): string {
	return `\`${text.replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("`", "\\`")}\``;
}

export function renderMarkdown(
	result: ConformanceCensus,
	rows: readonly ConformanceRow[],
	section?: string,
): string {
	const byPath = new Map(rows.map((row) => [row.path, row]));
	const lines = [
		`# explain vs device: \`${CONFORMANCE_COLLECTION}\` (snapshot ${result.snapshot})`,
		"",
		`${result.cases} cases. Offline: ${result.offline.pass} pass, ${result.offline.warn} warn, ` +
			`${result.offline.fail} fail. Device (all channels): ${result.device.accept} accept, ` +
			`${result.device.reject} reject, ${result.device.split} split.`,
		"",
		"| channel | version | accepted | rejected |",
		"| ------- | ------- | -------- | -------- |",
		...Object.entries(result.channels).map(
			([channel, c]) =>
				`| ${channel} | ${c.version} | ${c.accepted} | ${c.rejected} |`,
		),
		"",
		`Missed rejections by device class: ${Object.entries(result.missedByClass)
			.map(([cls, n]) => `${n} \`${cls}\``)
			.join(", ")}.`,
	];
	const list = (title: string, entries: Record<string, string>) => {
		const paths = Object.keys(entries).filter(
			(path) =>
				section === undefined ||
				(byPath.get(path)?.section ?? "").includes(section),
		);
		lines.push("", `## ${title} (${paths.length})`, "");
		for (const path of paths)
			lines.push(
				`- \`${path}\` ${shown(byPath.get(path)?.text ?? "")}: ${entries[path]}`,
			);
	};
	list("False rejects: offline fail, device accepts", result.falseRejects);
	list(
		"Missed rejections: offline pass/warn, device rejects",
		result.missedRejections,
	);
	list("Channels disagree", result.split);
	list("Upstream label vs device (#507)", result.upstreamDisagreements);
	return lines.join("\n");
}

function flag(args: readonly string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
}

export async function main(args: readonly string[]): Promise<number> {
	const check = args.includes("--check");
	const section = flag(args, "--section");
	if (check && section !== undefined) {
		console.error(
			"::error title=explain conformance::--section filters the report; the gate reads every case.",
		);
		return 1;
	}
	const resolution = resolveCorpusDb(flag(args, "--db"));
	if (resolution.warning)
		console.error(`::warning title=explain conformance::${resolution.warning}`);
	if (check && resolution.warning) {
		console.error(
			"::error title=explain conformance::refusing to check against a corpus " +
				"that is not the pinned snapshot — the result would not be comparable to CI's.",
		);
		return 1;
	}
	const dbPath = resolution.path;
	if (dbPath === undefined || !(await Bun.file(dbPath).exists())) {
		console.error(unreachableMessage("explain conformance"));
		return 1;
	}
	console.error(describeResolution(resolution));
	const { rows, channels, snapshot } = loadRows(dbPath);
	const result = census(rows, channels, snapshot);
	if (check) {
		const pinned = JSON.parse(
			readFileSync(FIXTURE_PATH, "utf8"),
		) as ConformanceCensus;
		const drift = diffAgainstFixture(result, pinned);
		if (drift.length > 0) {
			console.error(
				"::error title=explain conformance::the census no longer matches " +
					"test/fixtures/explain/conformance.json. Re-adopt with " +
					"`bun run explain:conformance --json > test/fixtures/explain/conformance.json` " +
					"and name the moved cases in the PR.",
			);
			for (const line of drift) console.error(`  ${line}`);
			return 1;
		}
		console.error("conformance census matches the committed fixture");
		return 0;
	}
	const out = args.includes("--json")
		? JSON.stringify(result, null, "\t")
		: renderMarkdown(result, rows, section);
	await Bun.write(Bun.stdout, `${out}\n`);
	return 0;
}

if (import.meta.main) {
	main(Bun.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(
				`::error title=explain conformance::${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		});
}
