// Q13 highlight-stream recapture — centrs#185, CHR batch top infra item.
//
// WHY: lsp-routeros-ts's collect-highlight.ts persisted only per-file token-class
// SETS (highlight-summary.v*.json → results[].types). That let Q13 Tier A
// FALSIFY at corpus scale (89.3%) but the per-occurrence metric (Tier B) only
// had 6 committed .rsc.highlight streams + 23 probe streams. This probe captures
// the per-CHARACTER stream for the WHOLE corpus so Tier B becomes a corpus-scale
// MEASUREMENT, not a 29-sample spot check. Q7/Q12/Q15 also name highlight as
// their oracle, so the artifact this writes is shared infrastructure.
//
// SELF-CONTAINED on purpose: the lab convention keeps probes in centrs .scratch/.
// The upstream "persist streams in collect-highlight.ts" ask stands as a
// follow-up — this does not need to entangle the two repos to get the number.
//
// It reads the EXACT corpus text the Q13 scorer feeds the SUT (corpus.sqlite
// source_scripts.text) and applies the EXACT upstream transform
// (replaceNonAscii(text.substring(0, 32767), '?')) so the stream and the SUT see
// byte-identical input. Files whose token count != byte length are recorded as
// misaligned and carry NO pairs (no fabrication past a desync — the X3 posture).
//
// Output: .scratch/explain-lab-q13-streams.v<version>.json  (gitignored)
//   { routerosVersion, chrBuildTime, environment, menuSurface, capturedAt,
//     corpusRows, aligned, misaligned, truncated,
//     streams: { [rel]: { pairs:[[frag,cls],…], bytes, truncated } } }
//
// Usage:  CHR_URL=http://127.0.0.1:9150 bun .scratch/explain-lab-q13-recapture.ts [--limit N]

import { Database } from "bun:sqlite";

const CHR_URL = process.env.CHR_URL ?? "http://127.0.0.1:9150";
const CHR_USER = process.env.CHR_USER ?? "admin";
const CHR_PASS = process.env.CHR_PASS ?? "";
const LSP = `${process.env.HOME}/GitHub/lsp-routeros-ts/test-data`;
const MAX_BYTES = 32767; // ROUTEROS_API_MAX_BYTES
const LIMIT = (() => {
	const i = process.argv.indexOf("--limit");
	return i >= 0 ? Number.parseInt(process.argv[i + 1] ?? "0", 10) : 0;
})();

const auth = `Basic ${Buffer.from(`${CHR_USER}:${CHR_PASS}`).toString("base64")}`;
const headers = { "Content-Type": "application/json", Authorization: auth };

async function rest(path: string, body?: unknown): Promise<unknown> {
	const resp = await fetch(`${CHR_URL}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(120_000),
	});
	const text = await resp.text();
	if (!resp.ok) throw new Error(`${path} → ${resp.status}: ${text.slice(0, 300)}`);
	return JSON.parse(text);
}

/** Exact copy of lsp-routeros-ts server/src/routeros.ts replaceNonAscii. */
function replaceNonAscii(text: string, replacement = "_"): string {
	let result = "";
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		result += c >= 0 && c <= 127 ? text.charAt(i) : replacement;
	}
	return result;
}

/** Run-length collapse a per-byte class list against its (ASCII) input. */
function runLength(input: string, tokens: string[]): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	let start = 0;
	for (let i = 1; i <= tokens.length; i++) {
		if (i === tokens.length || tokens[i] !== tokens[start]) {
			out.push([input.slice(start, i), tokens[start] as string]);
			start = i;
		}
	}
	return out;
}

async function highlight(input: string): Promise<string[]> {
	const data = (await rest("/rest/console/inspect", { request: "highlight", input })) as Array<Record<string, string>>;
	const hl = data[0]?.highlight ?? "";
	return hl.length === 0 ? [] : hl.split(",");
}

async function captureEnvironment() {
	const r = (await rest("/rest/system/resource")) as Record<string, string>;
	const pkgs = (await rest("/rest/system/package")) as Array<Record<string, string>>;
	return {
		version: (r.version ?? "").trim().split(/\s+/)[0] || "unknown",
		buildTime: r["build-time"] ?? "",
		architectureName: r["architecture-name"] ?? "",
		boardName: r["board-name"] ?? "",
		packages: pkgs
			.map((p) => ({ name: p.name ?? "", version: p.version ?? "", disabled: p.disabled === "true" }))
			.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

/**
 * X5 device menu surface — the completion set at the console root. `bad command
 * name` in the IL oracle is device-capability-dependent (CHR lacks
 * /container,/iot,/app,…); recording the actual top-level menu names lets a later
 * reader tell "invalid" from "missing on this build".
 */
async function captureMenuSurface(): Promise<string[]> {
	try {
		const data = (await rest("/rest/console/inspect", { request: "completion", input: "/" })) as Array<Record<string, unknown>>;
		const names = new Set<string>();
		for (const item of data) {
			const c = item.completion ?? item.name ?? item.value;
			if (typeof c === "string") names.add(c.replace(/^\//, "").replace(/[/ ].*$/, ""));
		}
		return [...names].sort();
	} catch (err) {
		return [`ERR:${err instanceof Error ? err.message : String(err)}`];
	}
}

async function main() {
	const environment = await captureEnvironment();
	const version = environment.version;
	console.log(`CHR ${CHR_URL} → RouterOS ${version} (build ${environment.buildTime}, board ${environment.boardName})`);
	const menuSurface = await captureMenuSurface();
	console.log(`menu surface (${menuSurface.length}): ${menuSurface.slice(0, 20).join(" ")}${menuSurface.length > 20 ? " …" : ""}`);

	const db = new Database(`${LSP}/corpus.sqlite`, { readonly: true });
	let rows = db.query("SELECT path, text FROM source_scripts ORDER BY path").all() as { path: string; text: string }[];
	if (LIMIT > 0) rows = rows.slice(0, LIMIT);
	console.log(`Recapturing highlight for ${rows.length} corpus scripts …`);

	const streams: Record<string, { pairs?: Array<[string, string]>; bytes: number; truncated: boolean; tokenCount: number; aligned: boolean }> = {};
	let aligned = 0;
	let misaligned = 0;
	let truncated = 0;
	let i = 0;
	for (const { path, text } of rows) {
		i++;
		const sent = replaceNonAscii(text.substring(0, MAX_BYTES), "?");
		const wasTruncated = text.length > MAX_BYTES;
		if (wasTruncated) truncated++;
		try {
			const tokens = await highlight(sent);
			const isAligned = tokens.length === sent.length; // sent is ASCII ⇒ chars == bytes
			if (isAligned) aligned++;
			else misaligned++;
			streams[path] = {
				bytes: sent.length,
				truncated: wasTruncated,
				tokenCount: tokens.length,
				aligned: isAligned,
				// No pairs on misalignment: a desynced stream compares tokens to the
				// wrong characters. Keep the counts, drop the fabrication.
				...(isAligned ? { pairs: runLength(sent, tokens) } : {}),
			};
		} catch (err) {
			misaligned++;
			streams[path] = { bytes: sent.length, truncated: wasTruncated, tokenCount: -1, aligned: false };
			console.log(`  [${i}/${rows.length}] ERR ${path}: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
		}
		if (i % 100 === 0 || i === rows.length) console.log(`  [${i}/${rows.length}] aligned=${aligned} misaligned=${misaligned}`);
	}

	const outPath = `.scratch/explain-lab-q13-streams.v${version}.json`;
	await Bun.write(
		outPath,
		`${JSON.stringify(
			{
				routerosVersion: version,
				chrBuildTime: environment.buildTime,
				environment,
				menuSurface,
				capturedAt: new Date().toISOString(),
				corpusRows: rows.length,
				aligned,
				misaligned,
				truncated,
				streams,
			},
			null,
			1,
		)}\n`,
	);
	console.log(`\nWrote ${outPath}: ${aligned} aligned / ${misaligned} misaligned / ${truncated} truncated of ${rows.length}`);
}

await main();
