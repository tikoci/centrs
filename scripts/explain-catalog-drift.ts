/**
 * Parse and report generated explain-catalog drift without fetching either
 * source. Keeping this separate from the generator makes the review surface
 * directly testable, including the GitHub Actions summary path.
 */

import { appendFileSync } from "node:fs";
import type { CatalogRow } from "./explain-catalog-data.ts";

export const DRIFT_REPORT_SENTINEL = "<!-- explain-catalog-drift -->";

export function parseCommittedCatalog(
	text: string,
): Map<string, CatalogRow> | null {
	const match = text.match(/const ROWS = `\r?\n([\s\S]*?)\r?\n`;\r?\n/);
	if (match === null) return null;
	const body = match[1] ?? "";
	const out = new Map<string, CatalogRow>();
	for (const raw of body.split(/\r?\n/)) {
		const line = raw.replace(/\r$/, "");
		if (line === "") continue;
		const parts = line.split("|");
		if (parts.length > 6) return null;
		const path = parts[0];
		const kind = parts[1];
		const provenance = parts[2];
		if (
			path === undefined ||
			kind === undefined ||
			provenance === undefined ||
			!["menu", "command", "settings"].includes(kind) ||
			!["inspect", "published", "both"].includes(provenance)
		)
			return null;
		const row: CatalogRow = {
			kind: kind as CatalogRow["kind"],
			path,
			provenance: provenance as CatalogRow["provenance"],
		};
		const pkg = parts[3];
		const cond = parts[4];
		const syscap = parts[5];
		if (pkg) row.package = pkg;
		if (cond) row.conditions = cond;
		if (syscap) row.syscap = syscap;
		if (out.has(path)) return null;
		out.set(path, row);
	}
	return out;
}

function formatGate(row: CatalogRow): string {
	const parts: string[] = [];
	if (row.package) parts.push(`package=${JSON.stringify(row.package)}`);
	if (row.conditions)
		parts.push(`conditions=${JSON.stringify(row.conditions)}`);
	if (row.syscap) parts.push(`syscap=${JSON.stringify(row.syscap)}`);
	return parts.length > 0 ? parts.join(" ") : "(none)";
}

export function buildDriftReport(
	committed: Map<string, CatalogRow> | null,
	freshRows: readonly CatalogRow[],
): string {
	const fresh = new Map(freshRows.map((row) => [row.path, row]));
	const lines: string[] = [];

	lines.push(DRIFT_REPORT_SENTINEL);
	lines.push("### `src/explain/catalog.ts` is out of date");
	lines.push("");
	lines.push("MikroTik's CLI Reference is current-only, so this fires on any");
	lines.push("structural change upstream. It is a REPORT, not a gate: nothing");
	lines.push("is blocked, including releases.");
	lines.push("");
	lines.push("To adopt the change: `bun run explain:catalog` and commit.");
	lines.push("Read the diff first — a path changing kind, or losing device");
	lines.push("provenance, changes what a caller may conclude from it.");
	lines.push("");

	if (committed === null) {
		lines.push(
			`Fresh catalog has ${fresh.size} paths; committed file could not be parsed (binary diff).`,
		);
		lines.push("");
		lines.push(
			"Run `bun run explain:catalog` and review `git diff src/explain/catalog.ts`.",
		);
		return lines.join("\n");
	}

	const countBy = (
		map: ReadonlyMap<string, CatalogRow>,
		predicate: (row: CatalogRow) => boolean,
	): number => {
		let n = 0;
		for (const row of map.values()) if (predicate(row)) n++;
		return n;
	};

	lines.push(
		`Row counts — committed ${committed.size.toLocaleString("en-US")} → fresh ${fresh.size.toLocaleString("en-US")} (Δ ${(fresh.size - committed.size).toLocaleString("en-US")})`,
	);
	lines.push("");
	lines.push("| Provenance | Committed | Fresh |");
	lines.push("| --- | --- | --- |");
	for (const prov of ["both", "inspect", "published"] as const) {
		lines.push(
			`| \`${prov}\` | ${countBy(committed, (r) => r.provenance === prov).toLocaleString("en-US")} | ${countBy(fresh, (r) => r.provenance === prov).toLocaleString("en-US")} |`,
		);
	}
	lines.push("");
	lines.push("| Kind | Committed | Fresh |");
	lines.push("| --- | --- | --- |");
	for (const kind of ["menu", "command", "settings"] as const) {
		lines.push(
			`| \`${kind}\` | ${countBy(committed, (r) => r.kind === kind).toLocaleString("en-US")} | ${countBy(fresh, (r) => r.kind === kind).toLocaleString("en-US")} |`,
		);
	}
	lines.push("");

	const added: CatalogRow[] = [];
	const removed: CatalogRow[] = [];
	for (const [path, row] of fresh) if (!committed.has(path)) added.push(row);
	for (const [path, row] of committed) if (!fresh.has(path)) removed.push(row);
	added.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	removed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	const isPublishedRelated = (row: CatalogRow): boolean =>
		row.provenance !== "inspect";
	const addedPublished = added.filter(isPublishedRelated);
	const removedPublished = removed.filter(isPublishedRelated);

	const cap = 40;
	const formatRows = (rows: readonly CatalogRow[]): string[] =>
		rows
			.slice(0, cap)
			.map(
				(r) =>
					`- \`${r.path}\` — \`${r.kind}\` \`${r.provenance}\`${r.package || r.conditions || r.syscap ? ` — ${formatGate(r)}` : ""}`,
			);

	lines.push(
		`#### Published paths added (${addedPublished.length}) / removed (${removedPublished.length})`,
	);
	if (addedPublished.length === 0 && removedPublished.length === 0) {
		lines.push("No published-related paths added or removed.");
	} else {
		if (addedPublished.length > 0) {
			lines.push(`Added (${addedPublished.length}):`);
			lines.push(...formatRows(addedPublished));
			if (addedPublished.length > cap)
				lines.push(`- … and ${addedPublished.length - cap} more`);
		}
		if (removedPublished.length > 0) {
			lines.push(`Removed (${removedPublished.length}):`);
			lines.push(...formatRows(removedPublished));
			if (removedPublished.length > cap)
				lines.push(`- … and ${removedPublished.length - cap} more`);
		}
		if (
			added.length !== addedPublished.length ||
			removed.length !== removedPublished.length
		) {
			lines.push("");
			lines.push(
				`(Also ${added.length - addedPublished.length} inspect-only added, ${removed.length - removedPublished.length} inspect-only removed — omitted above.)`,
			);
		}
	}
	lines.push("");

	const provenanceFlips: {
		path: string;
		from: CatalogRow["provenance"];
		to: CatalogRow["provenance"];
		kind: CatalogRow["kind"];
	}[] = [];
	const gateChanges: string[] = [];
	const kindChanges: string[] = [];
	const formatFlip = (flip: {
		path: string;
		from: CatalogRow["provenance"];
		to: CatalogRow["provenance"];
		kind: CatalogRow["kind"];
	}): string =>
		`- \`${flip.path}\` — \`${flip.from}\` → \`${flip.to}\` (\`${flip.kind}\`)`;
	for (const [path, freshRow] of fresh) {
		const old = committed.get(path);
		if (old === undefined) continue;
		if (old.provenance !== freshRow.provenance)
			provenanceFlips.push({
				path,
				from: old.provenance,
				to: freshRow.provenance,
				kind: freshRow.kind,
			});
		if (old.kind !== freshRow.kind)
			kindChanges.push(
				`- \`${path}\` — \`${old.kind}\` → \`${freshRow.kind}\``,
			);
		const gateKeys: (keyof CatalogRow)[] = ["package", "conditions", "syscap"];
		const gateDiff = gateKeys.some(
			(key) => (old[key] ?? "") !== (freshRow[key] ?? ""),
		);
		if (gateDiff)
			gateChanges.push(
				`- \`${path}\` — ${formatGate(old)} → ${formatGate(freshRow)}`,
			);
	}
	provenanceFlips.sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
	kindChanges.sort();
	gateChanges.sort();

	lines.push(`#### Provenance changes (${provenanceFlips.length})`);
	if (provenanceFlips.length === 0) lines.push("No provenance flips.");
	else {
		const bothToPublished = provenanceFlips.filter(
			(flip) => flip.from === "both" && flip.to === "published",
		);
		if (bothToPublished.length > 0) {
			lines.push(
				`Both → published (losing device confirmation, ${bothToPublished.length}):`,
			);
			lines.push(...bothToPublished.slice(0, cap).map(formatFlip));
			if (bothToPublished.length > cap)
				lines.push(`- … and ${bothToPublished.length - cap} more`);
		}
		const rest = provenanceFlips.filter(
			(flip) => !(flip.from === "both" && flip.to === "published"),
		);
		if (rest.length > 0) {
			if (bothToPublished.length > 0) lines.push("Other provenance flips:");
			lines.push(...rest.slice(0, cap).map(formatFlip));
			if (rest.length > cap) lines.push(`- … and ${rest.length - cap} more`);
		}
	}
	lines.push("");

	if (kindChanges.length > 0) {
		lines.push(`#### Kind changes (${kindChanges.length})`);
		lines.push(
			"These are committed → fresh changes. Cross-source kind contradictions abort before this report is built.",
		);
		lines.push(...kindChanges.slice(0, cap));
		if (kindChanges.length > cap)
			lines.push(`- … and ${kindChanges.length - cap} more`);
		lines.push("");
	}

	lines.push(`#### Gate-string changes (${gateChanges.length})`);
	if (gateChanges.length === 0) lines.push("No gate changes.");
	else {
		lines.push(...gateChanges.slice(0, cap));
		if (gateChanges.length > cap)
			lines.push(`- … and ${gateChanges.length - cap} more`);
	}
	lines.push("");

	return lines.join("\n");
}

/** Append without truncating earlier steps; summary publication is best-effort. */
export function appendDriftReportToSummary(
	report: string,
	summaryPath: string | undefined,
): boolean {
	if (!summaryPath) return false;
	try {
		appendFileSync(summaryPath, `${report}\n`);
		return true;
	} catch {
		return false;
	}
}
