/**
 * Ground the #574 submission matrix: scope, menu, and encoding probes across
 * centrs' delivery routes on disposable CHRs.
 *
 * Every cell runs THROUGH CENTRS: `executeEnvelope()` with a pinned `--via`
 * for the rest/native/ssh/mac-telnet legs, `MacTelnetConsole` held open per
 * cell for the session leg, and REST-created `/system/script` + product-REST
 * run for the stored leg. Two CHRs total (one IP-routes, one MAC), each cell
 * with unique variable/script/list names so no cell can contaminate another;
 * identity is never renamed and nothing reboots.
 *
 * A product call that centrs VALIDATION rejects is recorded as a rejection
 * (code, stage, message) plus a `quickchr-direct` fallback (device semantics
 * only, honestly labeled non-centrs). Runtime `routeros/*` errors are matrix
 * data, not probe failures; transport/auth/usage failures abort loudly.
 *
 * The write-confirmation gate is transport-independent (centrs-side), so it is
 * observed once per command shape on the fast rest leg; the matrix itself runs
 * with `yes: true` on throwaway machines.
 *
 * Run: bun run explain:probe:context-matrix [version] (default 7.24.5).
 * Captures land in `.scratch/explain-context-matrix.*.json` (in-flight by
 * design). The reviewed slice lives at
 * `test/fixtures/explain/context-matrix.slice.json`, regenerated mechanically
 * with `bun run explain:probe:context-matrix --slice <matrix.json> [out]`
 * (cells/gate/inputs from the capture; routes/findings prose preserved for
 * human review — a re-record that changes conclusions needs its prose and
 * replay test updated too, and the test fails until they are). This probe
 * establishes the submission matrix only — no `--context` modes, fields, or
 * binding behavior ship from it.
 */
// cspell:ignore cmx héllo nohome UNREVIEWED archs
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecuteRequest, executeEnvelope } from "../../src/execute.ts";
import { parseMac } from "../../src/protocols/mac-telnet.ts";
import { MacTelnetConsole } from "../../src/protocols/mac-telnet-console.ts";
import { transferEnvelope } from "../../src/transfer.ts";
import {
	readEnv,
	splitQuickChrAuth,
	startIntegrationChr,
} from "../../test/integration/chr.ts";
import {
	HOST_MAC,
	startMacTelnetL2Bridge,
} from "../../test/integration/mactelnet-l2-bridge.ts";
import { probeOutputPath } from "./chr.ts";

const VERSION = Bun.argv[2] ?? "7.24.5";
/** Pinned guest arch: host arch, never a contributor's CENTRS_CHR_ARCH. */
const GUEST_ARCH: "arm64" | "x86" = process.arch === "arm64" ? "arm64" : "x86";
const MT_USER = "cmx";
const MT_PASSWORD = "cmx-secret";
const MENU_LIST = "probe-574";
const MENU_ADDR = "192.0.2.44/32";

const sha256 = (s: string): string =>
	createHash("sha256").update(s, "utf8").digest("hex");

function cap(text: string, limit = 4000): { text: string; truncated: boolean } {
	return text.length > limit
		? { text: text.slice(0, limit), truncated: true }
		: { text, truncated: false };
}

async function timed<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
	const start = Date.now();
	const value = await fn();
	return { value, ms: Date.now() - start };
}

/** One recorded device interaction: exact bytes in, raw answer out. */
interface RecordedCall {
	bytes: string;
	bytesSha256: string;
	ms: number;
	ok: boolean;
	dataJson: string;
	dataTruncated: boolean;
	dataSha256: string;
	error?: { code: string; summary: string; cause?: string };
	/** True for transport/auth/usage failures: broken lab OR the route refusing the shape — curation decides. */
	infraSuspect?: boolean;
	/** Session-route only: the unextracted console screen (device truth behind the reader). */
	rawJson?: string;
	rawTruncated?: boolean;
	rawSha256?: string;
	via?: string;
	validation?: unknown;
	note?: string;
}

interface CellRecord {
	cell: string;
	input: string;
	route: string;
	/** One entry per submission: a one-shot cell has one, a split cell N. */
	submissions: RecordedCall[];
	/** Device-semantics fallbacks where the product path was validation-gated. */
	fallbacks?: (RecordedCall & { reason: string })[];
}

type Chr = Awaited<ReturnType<typeof startIntegrationChr>>["chr"];

async function actualVersion(chr: Chr): Promise<string> {
	const resource = (await chr.rest("/system/resource")) as Record<
		string,
		string
	>;
	return resource["version"] ?? "unknown";
}

/** Best-effort guest arch cross-check; never fails the probe. */
async function actualArch(chr: Chr): Promise<string> {
	try {
		const resource = (await chr.rest("/system/resource")) as Record<
			string,
			string
		>;
		return resource["architecture-name"] ?? "unknown";
	} catch {
		return "unknown";
	}
}

/** Non-centrs device-semantics fallback for validation-gated submissions. */
async function directCall(chr: Chr, command: string): Promise<RecordedCall> {
	const started = Date.now();
	try {
		const value = await chr.exec(command);
		const payload = JSON.stringify(value) ?? "";
		const data = cap(payload);
		return {
			bytes: command,
			bytesSha256: sha256(command),
			ms: Date.now() - started,
			ok: true,
			dataJson: data.text,
			dataTruncated: data.truncated,
			dataSha256: sha256(payload),
			note: "quickchr-direct, non-centrs",
		};
	} catch (error) {
		return {
			bytes: command,
			bytesSha256: sha256(command),
			ms: Date.now() - started,
			ok: false,
			dataJson: "",
			dataTruncated: false,
			dataSha256: sha256(""),
			error: {
				code: "direct-throw",
				summary: String(
					(error as { message?: unknown }).message ?? error,
				).slice(0, 500),
			},
			note: "quickchr-direct, non-centrs",
		};
	}
}

async function setupMenuEntry(chr: Chr): Promise<void> {
	const res = (await chr.rest("/ip/firewall/address-list", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			list: MENU_LIST,
			address: MENU_ADDR,
			comment: "probe-574-menu",
		}),
	})) as Record<string, unknown>;
	if (typeof res[".id"] !== "string")
		throw new Error(`menu setup entry missing .id: ${JSON.stringify(res)}`);
}

/**
 * One product-path cell: each submission is an executeEnvelope call. The
 * record lands in `sink` in a finally, so an abort (infra streak, setup
 * throw) still preserves the submissions already recorded.
 */
async function runProductCell(
	cell: string,
	input: string,
	route: string,
	submissions: string[],
	base: ProductBase,
	env: Record<string, string | undefined>,
	chr: Chr,
	sink: CellRecord[],
	bootRetry = false,
): Promise<CellRecord> {
	const record: CellRecord = { cell, input, route, submissions: [] };
	try {
		for (const bytes of submissions) {
			const call = await productCall(base, bytes, env, bootRetry);
			record.submissions.push(call);
			noteInfra(call, cell);
			if (!call.ok && call.error?.code.startsWith("validation/")) {
				const fb = await directCall(chr, bytes);
				record.fallbacks = [
					...(record.fallbacks ?? []),
					{ ...fb, reason: `product validation rejected: ${call.error.code}` },
				];
			}
		}
		console.log(
			`OK ${cell}: ${record.submissions.map((s) => (s.ok ? "ok" : (s.error?.code ?? "err"))).join(",")}`,
		);
		return record;
	} finally {
		sink.push(record);
	}
}

/**
 * Deterministic env for every product call in the matrix: no `CENTRS_*` from
 * the shell, the `centrs.env` file tier skipped outright, and HOME/XDG parked
 * in an empty temp dir so the default CDB path resolves to nothing. Without
 * this, a contributor's `CENTRS_VALIDATE=false` file or a CDB record matching
 * a probe target would silently record a different matrix.
 */
async function cleanEnv(): Promise<Record<string, string | undefined>> {
	const home = await mkdtemp(join(tmpdir(), "centrs-574-nohome-"));
	const scrubbed: Record<string, string | undefined> = Object.fromEntries(
		Object.entries(Bun.env).filter(([k]) => !k.startsWith("CENTRS_")),
	);
	return {
		...scrubbed,
		CENTRS_SKIP_ENV_FILE: "1",
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
	};
}

type ProductBase = Omit<ExecuteRequest, "command">;

function toRecorded(
	command: string,
	ms: number,
	envelope: Awaited<ReturnType<typeof executeEnvelope>>,
): RecordedCall {
	const payload = envelope.ok
		? JSON.stringify(envelope.data)
		: JSON.stringify(envelope.error);
	const data = cap(payload ?? "");
	const error = envelope.ok
		? undefined
		: {
				code: String((envelope.error as { code?: unknown }).code ?? "unknown"),
				summary: String(
					(envelope.error as { summary?: unknown }).summary ??
						(envelope.error as { message?: unknown }).message ??
						"",
				).slice(0, 500),
				cause: JSON.stringify(
					(envelope.error as { causeData?: unknown }).causeData ??
						(envelope.error as { cause?: unknown }).cause ??
						null,
				).slice(0, 1000),
			};
	const code = error?.code ?? "";
	return {
		bytes: command,
		bytesSha256: sha256(command),
		ms,
		ok: envelope.ok,
		dataJson: data.text,
		dataTruncated: data.truncated,
		dataSha256: sha256(payload ?? ""),
		...(error ? { error } : {}),
		...(error &&
		!code.startsWith("validation/") &&
		!code.startsWith("routeros/")
			? { infraSuspect: true as const }
			: {}),
		via: String((envelope.meta as { via?: unknown }).via ?? "unknown"),
		validation: (envelope.meta as { validation?: unknown }).validation,
	};
}

const TRANSIENT_CONNECT_CODES = new Set([
	"transport/connection-refused",
	"transport/timeout",
]);

/**
 * One product-path submission. Every envelope outcome is recorded and
 * returned — even transport/auth failures, which may be the route refusing
 * the shape rather than broken lab (flagged `infraSuspect` for curation).
 * Only a throw out of the envelope call itself aborts the run. With
 * `bootRetry`, transient connect errors retry: the API service listens
 * later than REST answers, so only the native leg sets it.
 */
async function productCall(
	base: ProductBase,
	command: string,
	env: Record<string, string | undefined>,
	bootRetry = false,
): Promise<RecordedCall> {
	const deadline = Date.now() + 90_000;
	for (;;) {
		const { value, ms } = await timed(() =>
			executeEnvelope({ ...base, command, yes: true }, env),
		);
		const recorded = toRecorded(command, ms, value);
		if (value.ok) return recorded;
		const code = recorded.error?.code ?? "";
		if (
			bootRetry &&
			TRANSIENT_CONNECT_CODES.has(code) &&
			Date.now() < deadline
		) {
			await Bun.sleep(2000);
			continue;
		}
		return recorded;
	}
}

/** Sustained lab-red aborts the run; isolated transport failures are data. */
const INFRA_ABORT_STREAK = 5;
let infraStreak = 0;

function noteInfra(call: RecordedCall, cell: string): void {
	if (call.infraSuspect) {
		infraStreak++;
		console.log(
			`INFRA-SUSPECT ${cell}: ${call.error?.code} cause=${call.error?.cause?.slice(0, 200)}`,
		);
		if (infraStreak >= INFRA_ABORT_STREAK)
			throw new Error(
				`${INFRA_ABORT_STREAK} consecutive infra-suspect calls; aborting broken lab run`,
			);
	} else {
		infraStreak = 0;
	}
}

// ---------------------------------------------------------------------------
// Inputs: byte-exact per cell (unique variable names per cell; identical
// shapes across routes). A "submission" is one execute call / console run.
// ---------------------------------------------------------------------------

interface MatrixInput {
	id: string;
	intent: string;
	/** Whole-input submissions (one entry = one call). */
	whole: (tag: string) => string[];
	/** Split-input submissions, when the input defines a split shape. */
	split?: (tag: string) => string[];
}

const INPUTS: MatrixInput[] = [
	{
		id: "I1-nl-scope",
		intent: "local/set/put across newlines: one scope or per-line scopes",
		whole: (t) => [`:local ${t} 1\n:set ${t} 2\n:put "a=$${t}"\n`],
		split: (t) => [`:local ${t} 1`, `:set ${t} 2`, `:put "a=$${t}"`],
	},
	{
		id: "I2-semi-scope",
		intent: "same three statements joined by semicolons on one line",
		whole: (t) => [`:local ${t} 1; :set ${t} 2; :put "a=$${t}"\n`],
	},
	{
		id: "I3-braces-1line",
		intent: "explicit braces around the three statements, one line",
		whole: (t) => [`{ :local ${t} 1; :set ${t} 2; :put "a=$${t}" }\n`],
	},
	{
		id: "I4-braces-multi",
		intent: "explicit braces with physical newlines inside (continuation)",
		whole: (t) => [`{\n:local ${t} 1\n:set ${t} 2\n:put "a=$${t}"\n}\n`],
	},
	{
		id: "I5-global",
		intent: "global set in one submission, read in the next",
		whole: () => [],
		split: (t) => [`:global ${t} 11\n`, `:put "g=$${t}"\n`],
	},
	{
		id: "I6-menu",
		intent: "menu navigation then print: context within vs across calls",
		whole: () => [`/ip/firewall/address-list\nprint\n`],
		split: () => [`/ip/firewall/address-list`, `print`],
	},
	{
		id: "I7-unicode",
		intent: "non-ascii output bytes per route",
		whole: () => [`:put "héllo→574"\n`],
	},
	{
		id: "I8-bom",
		intent: "leading BOM before a trivial command per route",
		whole: () => [`\uFEFF:put "bom574"\n`],
	},
];

/** Cell-local variable tag: alphanumeric, unique per (input, route, shape). */
function tagFor(cell: string, global: boolean): string {
	const stem = `${global ? "g574" : "a574"}${cell.replace(/[^A-Za-z0-9]/g, "")}`;
	return stem.slice(0, 24);
}

function spawnKeygen(path: string) {
	try {
		return Bun.spawn(
			["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "centrs-574", "-f", path],
			{ stdout: "pipe", stderr: "pipe" },
		);
	} catch (cause) {
		throw new Error("context-matrix needs a local `ssh-keygen`", { cause });
	}
}

interface SessionCtx {
	bridge: Awaited<ReturnType<typeof startMacTelnetL2Bridge>>;
	destinationMac: Uint8Array;
	username: string;
	password: string;
}

/** One session-route cell: a fresh console, one run() per submission. */
async function runSessionCell(
	cell: string,
	input: string,
	submissions: string[],
	ctx: SessionCtx,
): Promise<CellRecord> {
	const record: CellRecord = { cell, input, route: "session", submissions: [] };
	const cons = new MacTelnetConsole({
		sink: {
			send: (b) => ctx.bridge.inject(b),
			close: () => {},
		},
		sourceMac: HOST_MAC,
		destinationMac: ctx.destinationMac,
		username: ctx.username,
		password: ctx.password,
		primeTimeoutMs: 60_000,
		commandTimeoutMs: 30_000,
	});
	ctx.bridge.onPacket((p) => cons.handlePacket(new Uint8Array(p)));
	try {
		const open = await timed(() => cons.open());
		console.log(`session ${cell}: console open in ${open.ms}ms`);
		for (const bytes of submissions) {
			const started = Date.now();
			try {
				const res = await cons.run(bytes);
				const payload = JSON.stringify({ output: res.output });
				const data = cap(payload);
				const raw = cap(JSON.stringify({ raw: res.raw }), 6000);
				record.submissions.push({
					bytes,
					bytesSha256: sha256(bytes),
					ms: Date.now() - started,
					ok: true,
					dataJson: data.text,
					dataTruncated: data.truncated,
					dataSha256: sha256(payload),
					rawJson: raw.text,
					rawTruncated: raw.truncated,
					rawSha256: sha256(JSON.stringify({ raw: res.raw })),
					via: "mac-telnet-session",
					note: "held console, one run() per submission",
				});
			} catch (error) {
				record.submissions.push({
					bytes,
					bytesSha256: sha256(bytes),
					ms: Date.now() - started,
					ok: false,
					dataJson: "",
					dataTruncated: false,
					dataSha256: sha256(""),
					error: {
						code: "session-run-failed",
						summary: String(
							(error as { message?: unknown }).message ?? error,
						).slice(0, 500),
					},
					via: "mac-telnet-session",
					note: "console may be wedged past this point in this cell",
				});
			}
		}
	} finally {
		ctx.bridge.onPacket(() => {});
		cons.close();
	}
	console.log(
		`OK ${cell}: ${record.submissions.map((s) => (s.ok ? "ok" : (s.error?.code ?? "err"))).join(",")}`,
	);
	return record;
}

interface StoredCtx {
	chr: Chr;
	restBase: ProductBase;
	env: Record<string, string | undefined>;
	sink: CellRecord[];
}

/** One stored-route cell: REST-created script(s), product-REST run each. */
async function runStoredCell(
	cell: string,
	input: string,
	sources: string[],
	ctx: StoredCtx,
): Promise<CellRecord> {
	const record: CellRecord = { cell, input, route: "stored", submissions: [] };
	try {
		let i = 0;
		for (const source of sources) {
			i++;
			const name = `cmx-${cell}-${i}`;
			const created = (await ctx.chr.rest("/system/script", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, source }),
			})) as Record<string, unknown>;
			if (typeof created[".id"] !== "string")
				throw new Error(
					`stored setup ${name} missing .id: ${JSON.stringify(created)}`,
				);
			const call = await productCall(
				ctx.restBase,
				`/system/script/run ${name}`,
				ctx.env,
			);
			call.note = `script ${name} source-sha256 ${sha256(source)}`;
			record.submissions.push(call);
			noteInfra(call, cell);
			if (!call.ok && call.error?.code.startsWith("validation/")) {
				const fb = await directCall(ctx.chr, `/system/script/run ${name}`);
				record.fallbacks = [
					...(record.fallbacks ?? []),
					{ ...fb, reason: `product validation rejected: ${call.error.code}` },
				];
			}
		}
		console.log(
			`OK ${cell}: ${record.submissions.map((s) => (s.ok ? "ok" : (s.error?.code ?? "err"))).join(",")}`,
		);
		return record;
	} finally {
		ctx.sink.push(record);
	}
}

async function main(): Promise<void> {
	const env = await cleanEnv();
	const t0 = Date.now();
	const gateTable: { shape: string; ok: boolean; code: string }[] = [];
	const cells: CellRecord[] = [];
	const versions: Record<string, string> = {};
	const archs: Record<string, string> = {};
	const writePartial = async (tag: string, error: unknown): Promise<void> => {
		await Bun.write(
			await probeOutputPath(
				`explain-context-matrix.v${VERSION}.${tag}.PARTIAL.json`,
			),
			`${JSON.stringify({ requestedVersion: VERSION, versions, error: String((error as { message?: unknown }).message ?? error), gateTable, cells }, null, 2)}\n`,
		);
	};

	// ---- CHR 1: IP routes (rest, native, ssh, stored) ----
	const ip = await startIntegrationChr({
		version: VERSION,
		arch: GUEST_ARCH,
		packages: [],
		name: `cmx-ip-${Date.now()}`,
	});
	try {
		const chr = ip.chr;
		if (!(await chr.waitForBoot(180_000)))
			throw new Error("ip CHR never booted");
		versions["ip"] = await actualVersion(chr);
		archs["ip"] = await actualArch(chr);
		const auth = splitQuickChrAuth(
			readEnv(ip.env, "QUICKCHR_AUTH") ?? "admin:",
		);
		await setupMenuEntry(chr);

		const restBase: ProductBase = {
			targetInput: chr.restUrl,
			via: "rest-api",
			username: auth.username,
			password: auth.password,
		};
		const nativeBase: ProductBase = {
			targetInput: "127.0.0.1",
			via: "native-api",
			port: chr.ports.api,
			username: auth.username,
			password: auth.password,
		};

		// SSH key dance (execute-ssh.test.ts recipe).
		const tmp = await mkdtemp(join(tmpdir(), "centrs-574-ssh-"));
		const key = join(tmp, "id");
		const keygen = spawnKeygen(key);
		if ((await keygen.exited) !== 0)
			throw new Error("ssh-keygen failed for the matrix probe");
		const keyUpload = await transferEnvelope(
			{
				verb: "upload",
				targetInput: chr.restUrl,
				username: auth.username,
				password: auth.password,
				local: `${key}.pub`,
				remote: "centrs_574.pub",
			},
			env,
		);
		if (!keyUpload.ok)
			throw new Error(
				`matrix ssh-key upload failed: ${(keyUpload.error as { code?: unknown }).code} ${JSON.stringify((keyUpload.error as { summary?: unknown }).summary ?? "").slice(0, 200)}`,
			);
		await chr.exec(
			`/user ssh-keys import public-key-file=centrs_574.pub user=${auth.username}`,
		);
		const sshBase: ProductBase = {
			targetInput: "127.0.0.1",
			via: "ssh",
			port: chr.sshPort,
			username: auth.username,
			sshKey: key,
			insecure: true,
		};

		// Gate table: one no-yes call per shape on the fast rest leg.
		await chr.rest("/system/script", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "cmx-gate", source: ':put "gate"\n' }),
		});
		const gateShapes: [string, string][] = [
			["I1", `:local gateI1 1\n:set gateI1 2\n:put "a=$gateI1"\n`],
			["I2", `:local gateI2 1; :set gateI2 2; :put "a=$gateI2"\n`],
			["I3", `{ :local gateI3 1; :set gateI3 2; :put "a=$gateI3" }\n`],
			["I4", `{\n:local gateI4 1\n:set gateI4 2\n:put "a=$gateI4"\n}\n`],
			["I5-set", `:global gateI5 11\n`],
			["I5-read", `:put "g=$gateI5"\n`],
			["I6-nav", `/ip/firewall/address-list\n`],
			["I6-print", `print\n`],
			["I7", `:put "héllo→574"\n`],
			["I8", `\uFEFF:put "bom574"\n`],
			["script-run", `/system/script/run cmx-gate`],
		];
		for (const [shape, bytes] of gateShapes) {
			// Pinned non-interactive: on a contributor TTY these no-yes calls
			// must record usage/confirmation-required, never prompt a human.
			const gate = await executeEnvelope(
				{ ...restBase, command: bytes, stdinIsTty: false },
				env,
			);
			gateTable.push({
				shape,
				ok: gate.ok,
				code: gate.ok
					? "ran"
					: String((gate.error as { code?: unknown }).code ?? "unknown"),
			});
		}
		console.log(`gate table: ${JSON.stringify(gateTable)}`);

		// Product legs.
		const legs: [string, ProductBase][] = [
			["rest", restBase],
			["native", nativeBase],
			["ssh", sshBase],
		];
		for (const [route, base] of legs) {
			const bootRetry = route === "native";
			for (const input of INPUTS) {
				const wholeId = `${input.id}-${route}`;
				const wholeSubs = input.whole(tagFor(wholeId, false));
				if (wholeSubs.length > 0)
					await runProductCell(
						wholeId,
						input.id,
						route,
						wholeSubs,
						base,
						env,
						chr,
						cells,
						bootRetry,
					);
				if (input.split) {
					const splitId = `${wholeId}-split`;
					const tag = tagFor(splitId, input.id === "I5-global");
					await runProductCell(
						splitId,
						input.id,
						route,
						input.split(tag),
						base,
						env,
						chr,
						cells,
						bootRetry,
					);
				}
			}
		}

		// Stored leg (shares the IP CHR; unique script names per cell). I1 has
		// no stored split: spreading one input's lines across stored scripts
		// is meaningless. I5/I6 splits are genuine two-script questions.
		const storedCtx: StoredCtx = { chr, restBase, env, sink: cells };
		for (const input of INPUTS) {
			const cell = `${input.id}-stored`;
			const wholeSubs = input.whole(tagFor(cell, false));
			if (wholeSubs.length > 0)
				await runStoredCell(cell, input.id, wholeSubs, storedCtx);
			if (input.split && input.id !== "I1-nl-scope") {
				const splitId = `${cell}-split`;
				const tag = tagFor(splitId, input.id === "I5-global");
				await runStoredCell(splitId, input.id, input.split(tag), storedCtx);
			}
		}

		await Bun.write(
			await probeOutputPath(`explain-context-matrix.v${VERSION}.ip.json`),
			`${JSON.stringify({ requestedVersion: VERSION, actualVersion: versions["ip"], actualArch: archs["ip"], gateTable, cells: cells.filter((c) => c.route !== "mactelnet" && c.route !== "session") }, null, 2)}\n`,
		);
	} catch (error) {
		await writePartial("ip", error);
		throw error;
	} finally {
		await ip.chr.remove();
	}

	// ---- CHR 2: MAC routes (product mactelnet, held session) ----
	const bridge = await startMacTelnetL2Bridge();
	try {
		const mac = await startIntegrationChr({
			version: VERSION,
			arch: GUEST_ARCH,
			packages: [],
			name: `cmx-mac-${Date.now()}`,
			networks: ["user", { type: "socket-connect", port: bridge.tcpPort }],
		});
		try {
			const chr = mac.chr;
			if (!(await chr.waitForBoot(180_000)))
				throw new Error("mac CHR never booted");
			if (!(await bridge.waitForConnection(10_000)))
				throw new Error("L2 bridge never connected");
			versions["mac"] = await actualVersion(chr);
			archs["mac"] = await actualArch(chr);
			await setupMenuEntry(chr);
			await chr.exec("/tool/mac-server set allowed-interface-list=all");
			await chr.exec(
				`/user/add name=${MT_USER} password=${MT_PASSWORD} group=full`,
			);
			const eths = (await chr.rest("/interface/ethernet")) as Record<
				string,
				string
			>[];
			const ether2 =
				eths.find((e) => e["name"] === "ether2") ?? eths[eths.length - 1];
			const targetMac = ether2?.["mac-address"] ?? "";
			if (!targetMac) throw new Error("no ether2 MAC for the mac leg");
			const dst = parseMac(targetMac);

			const macBase: ProductBase = {
				targetInput: targetMac,
				via: "mac-telnet",
				host: "127.0.0.1",
				port: bridge.udpPort,
				username: MT_USER,
				password: MT_PASSWORD,
			};
			for (const input of INPUTS) {
				const wholeId = `${input.id}-mactelnet`;
				const wholeSubs = input.whole(tagFor(wholeId, false));
				if (wholeSubs.length > 0)
					await runProductCell(
						wholeId,
						input.id,
						"mactelnet",
						wholeSubs,
						macBase,
						env,
						chr,
						cells,
					);
				if (input.split) {
					const splitId = `${wholeId}-split`;
					const tag = tagFor(splitId, input.id === "I5-global");
					await runProductCell(
						splitId,
						input.id,
						"mactelnet",
						input.split(tag),
						macBase,
						env,
						chr,
						cells,
					);
				}
			}

			const sessionCtx: SessionCtx = {
				bridge,
				destinationMac: dst,
				username: MT_USER,
				password: MT_PASSWORD,
			};
			for (const input of INPUTS) {
				const wholeId = `${input.id}-session`;
				const wholeSubs = input.whole(tagFor(wholeId, false));
				if (wholeSubs.length > 0)
					cells.push(
						await runSessionCell(wholeId, input.id, wholeSubs, sessionCtx),
					);
				if (input.split) {
					const splitId = `${wholeId}-split`;
					const tag = tagFor(splitId, input.id === "I5-global");
					cells.push(
						await runSessionCell(
							splitId,
							input.id,
							input.split(tag),
							sessionCtx,
						),
					);
				}
			}

			await Bun.write(
				await probeOutputPath(`explain-context-matrix.v${VERSION}.mac.json`),
				`${JSON.stringify({ requestedVersion: VERSION, actualVersion: versions["mac"], actualArch: archs["mac"], targetMac, cells: cells.filter((c) => c.route === "mactelnet" || c.route === "session") }, null, 2)}\n`,
			);
		} catch (error) {
			await writePartial("mac", error);
			throw error;
		} finally {
			await mac.chr.remove();
		}
	} finally {
		await bridge.close();
	}

	await Bun.write(
		await probeOutputPath(`explain-context-matrix.v${VERSION}.matrix.json`),
		`${JSON.stringify(
			{
				requestedVersion: VERSION,
				versions,
				archs,
				elapsedMs: Date.now() - t0,
				gateTable,
				inputs: INPUTS.map((i) => ({ id: i.id, intent: i.intent })),
				cells,
			},
			null,
			2,
		)}\n`,
	);
	console.log(`matrix complete: ${cells.length} cells in ${Date.now() - t0}ms`);
}

const SLICE_PATH = "test/fixtures/explain/context-matrix.slice.json";

interface MatrixCapture {
	requestedVersion: string;
	versions: Record<string, string>;
	archs?: Record<string, string>;
	elapsedMs: number;
	gateTable: unknown;
	inputs: unknown;
	cells: CellRecord[];
}

const SLICE_INPUT_ORDER = [
	"I1-nl-scope",
	"I2-semi-scope",
	"I3-braces-1line",
	"I4-braces-multi",
	"I5-global",
	"I6-menu",
	"I7-unicode",
	"I8-bom",
];
const SLICE_ROUTE_ORDER = [
	"rest",
	"native",
	"ssh",
	"mactelnet",
	"session",
	"stored",
];

function slimSubmission(
	s: RecordedCall,
	wantRaw: boolean,
): Record<string, unknown> {
	const stages = (
		(s.validation as { stages?: { stage?: unknown; result?: unknown }[] })
			?.stages ?? []
	).map((st) => [st.stage, st.result]);
	const o: Record<string, unknown> = {
		bytes: s.bytes,
		sha256: s.bytesSha256,
		ms: s.ms,
		ok: s.ok,
	};
	if (s.ok) {
		o["out"] = s.dataJson.slice(0, 400);
		if (s.dataTruncated) o["outTruncated"] = true;
	} else {
		const err: Record<string, unknown> = {
			code: s.error?.code,
			summary: s.error?.summary,
		};
		if (s.error?.cause) err["cause"] = s.error.cause.slice(0, 300);
		o["error"] = err;
	}
	if (stages.length > 0) o["stages"] = stages;
	if (s.infraSuspect) o["infraSuspect"] = true;
	if (s.note) o["note"] = s.note;
	if (wantRaw && s.rawJson) o["raw"] = s.rawJson.slice(0, 2500);
	return o;
}

/**
 * Regenerate the committed slice from a matrix capture. Cells, gate table,
 * inputs, and versions come from the capture; `_source`, `routes`, and
 * `findings` are curated prose preserved from the existing slice (or a TODO
 * template on first curation). Session submissions always carry their raw
 * screen — the device truth behind the console reader.
 */
async function sliceMode(capturePath: string, outPath: string): Promise<void> {
	const matrix = (await Bun.file(capturePath).json()) as MatrixCapture;
	let prev: Record<string, unknown> = {};
	try {
		prev = (await Bun.file(outPath).json()) as Record<string, unknown>;
	} catch {
		console.log(`no existing slice at ${outPath}; writing TODO prose`);
	}
	const rank = (c: CellRecord): [number, number] => [
		SLICE_INPUT_ORDER.indexOf(c.input),
		SLICE_ROUTE_ORDER.indexOf(c.route),
	];
	const cells = [...matrix.cells]
		.sort((a, b) => {
			const [ai, ar] = rank(a);
			const [bi, br] = rank(b);
			return ai !== bi
				? ai - bi
				: ar !== br
					? ar - br
					: a.cell < b.cell
						? -1
						: 1;
		})
		.map((c) => {
			const wantRaw = c.route === "session";
			const e: Record<string, unknown> = {
				cell: c.cell,
				input: c.input,
				route: c.route,
				submissions: c.submissions.map((s) => slimSubmission(s, wantRaw)),
			};
			if (c.fallbacks)
				e["fallbacks"] = c.fallbacks.map((f) => ({
					bytes: f.bytes,
					ok: f.ok,
					out: f.dataJson.slice(0, 250),
					reason: f.reason,
				}));
			return e;
		});
	const slice = {
		_source:
			prev["_source"] ??
			"UNREVIEWED — curate provenance, then re-run the replay test",
		routerosVersion: matrix.versions["ip"],
		arch: matrix.archs?.["ip"] ?? "unknown",
		routes: prev["routes"] ?? {},
		gateTable: matrix.gateTable,
		inputs: matrix.inputs,
		findings: prev["findings"] ?? ["UNREVIEWED — curate before commit"],
		cells,
	};
	await Bun.write(outPath, `${JSON.stringify(slice, null, 2)}\n`);
	console.log(
		`slice written to ${outPath} (${cells.length} cells); run \`bunx biome check --write ${outPath}\` before commit`,
	);
}

if (Bun.argv[2] === "--slice") {
	const capture = Bun.argv[3];
	if (!capture) {
		console.error(
			"usage: bun run explain:probe:context-matrix --slice <matrix.json> [slice-out]",
		);
		process.exit(2);
	}
	await sliceMode(capture, Bun.argv[4] ?? SLICE_PATH);
} else {
	await main();
}
