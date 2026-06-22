/**
 * `centrs btest` CLI surface: the `client <router>` and `server` sub-verbs, arg
 * parsing, option-grammar dispatch, and live (text/csv) vs final (json/yaml)
 * output. Flag names mirror `/tool/bandwidth-test` and `/tool/bandwidth-server`
 * verbatim; centrs adds only `--bind` (server safety) and the shared `--format`.
 */

import {
	BTEST_CLIENT_CSV_HEADER,
	BTEST_SERVER_CSV_HEADER,
	type BtestClientRequest,
	type BtestOutputFormat,
	type BtestServerRequest,
	btestClient,
	btestClientCsvRow,
	btestClientSummaryLine,
	btestOutputFormats,
	btestServer,
	btestServerCsvRow,
	btestServerSummaryLine,
	formatBtestReportText,
	formatBtestSessionText,
	renderBtestClientEnvelope,
	renderBtestServerEnvelope,
} from "../btest.ts";
import { asCentrsError, formatCentrsErrorText } from "../errors.ts";
import { describeCentrs, parseDuration } from "../index.ts";
import type { BtestDirection, BtestProtocol } from "../protocols/btest.ts";
import { toYaml } from "../retrieve.ts";
import {
	type CliCommandMetadata,
	expectValue,
	renderCommandHelp,
} from "./common.ts";
import {
	buildTargetSelectionTips,
	cdbFileFromArgs,
	formatTipsText,
	isMissingTargetError,
	missingTargetError,
	withTips,
} from "./missing-target.ts";

export const btestCommand: CliCommandMetadata = {
	name: "btest",
	usage: "centrs btest <client <router>|server> [flags]",
	summary:
		"Run MikroTik's bandwidth test as a client or server (peer measurement).",
	options: [
		{
			flag: "--protocol",
			valueName: "<udp|tcp>",
			description: "(client) Transport. Default udp.",
		},
		{
			flag: "--direction",
			valueName: "<receive|transmit|both>",
			description: "(client) Test direction. Default receive.",
		},
		{
			flag: "--duration",
			valueName: "<dur>",
			description: "Bound the run (e.g. 15s). Omit for open-ended (Ctrl-C).",
		},
		{
			flag: "--interval",
			valueName: "<dur>",
			description: "Report cadence (20ms..5s). Default 1s.",
		},
		{
			flag: "--connection-count",
			valueName: "<n>",
			description: "(client, TCP only) Parallel TCP data connections (1..255).",
		},
		{
			flag: "--local-udp-tx-size",
			valueName: "<n>",
			description: "(client, UDP only) Client→server packet size (28..64000).",
		},
		{
			flag: "--remote-udp-tx-size",
			valueName: "<n>",
			description: "(client, UDP only) Server→client packet size (28..64000).",
		},
		{
			flag: "--local-tx-speed",
			valueName: "<bps>",
			description: "(client) Cap on client→server rate (e.g. 100M).",
		},
		{
			flag: "--remote-tx-speed",
			valueName: "<bps>",
			description: "(client) Cap on server→client rate (e.g. 100M).",
		},
		{ flag: "--random-data", description: "(client) Incompressible payload." },
		{
			flag: "--authenticate[=false]",
			description: "(server) Require EC-SRP5 auth. Default true.",
		},
		{
			flag: "--bind",
			valueName: "<addr>",
			description: "(server) Listen address. Default 127.0.0.1.",
		},
		{
			flag: "--allocate-udp-ports-from",
			valueName: "<n>",
			description: "(server) Base of the UDP data-port range. Default 2001.",
		},
		{
			flag: "--max-sessions",
			valueName: "<n>",
			description: "(server) Concurrent test cap (1..1000). Default 100.",
		},
		{
			flag: "--user / --username / -u",
			valueName: "<name>",
			description:
				"Credential (aliases --username, -u; falls back to CDB / CENTRS_USERNAME).",
		},
		{
			flag: "--password",
			valueName: "<secret>",
			description: "Credential (falls back to CDB / CENTRS_PASSWORD).",
		},
		{
			flag: "--port",
			valueName: "<port>",
			description: "Control port. Default 2000.",
		},
		{
			flag: "--format",
			valueName: `<${btestOutputFormats.join("|")}>`,
			description: "Output format. Default text.",
		},
		{ flag: "--csv", description: "Shortcut for `--format csv`." },
	],
};

/** Parse a bandwidth value: a bare integer or a `K`/`M`/`G` suffix (bits/sec). */
function parseBandwidth(value: string, flag: string): number {
	const match = value.trim().match(/^(\d+(?:\.\d+)?)([kKmMgG]?)$/);
	if (!match) {
		throw new Error(
			`${flag} must be a number with optional K/M/G; got ${value}.`,
		);
	}
	const scale: Record<string, number> = {
		"": 1,
		k: 1e3,
		m: 1e6,
		g: 1e9,
	};
	const result = Math.round(
		Number(match[1]) * (scale[(match[2] ?? "").toLowerCase()] ?? 1),
	);
	if (result > 0xffffffff) {
		throw new Error(`${flag} exceeds the 32-bit wire field (max ~4.29G).`);
	}
	return result;
}

function parseIntFlag(value: string, flag: string): number {
	const n = Number.parseInt(value, 10);
	if (!Number.isInteger(n))
		throw new Error(`${flag} must be an integer; got ${value}.`);
	return n;
}

function parseFormat(value: string): BtestOutputFormat {
	if (!btestOutputFormats.includes(value as BtestOutputFormat)) {
		throw new Error(
			`--format must be one of ${btestOutputFormats.join(", ")}; got ${value}.`,
		);
	}
	return value as BtestOutputFormat;
}

interface CommonCliArgs {
	help?: boolean;
	format?: BtestOutputFormat;
}

interface ClientCliArgs extends CommonCliArgs {
	request: BtestClientRequest;
}

interface ServerCliArgs extends CommonCliArgs {
	request: BtestServerRequest;
}

function parseClientArgs(args: readonly string[]): ClientCliArgs {
	const request: BtestClientRequest = { env: Bun.env };
	const parsed: ClientCliArgs = { request };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === undefined) continue;
		switch (arg) {
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			case "--protocol": {
				const v = expectValue(args, ++i, arg);
				if (v !== "udp" && v !== "tcp")
					throw new Error(`--protocol must be udp|tcp; got ${v}.`);
				request.protocol = v as BtestProtocol;
				break;
			}
			case "--direction": {
				const v = expectValue(args, ++i, arg);
				if (v !== "receive" && v !== "transmit" && v !== "both")
					throw new Error(
						`--direction must be receive|transmit|both; got ${v}.`,
					);
				request.direction = v as BtestDirection;
				break;
			}
			case "--duration":
				request.durationMs = parseDuration(expectValue(args, ++i, arg));
				break;
			case "--interval":
				request.intervalMs = parseDuration(expectValue(args, ++i, arg));
				break;
			case "--connection-count":
				request.connectionCount = parseIntFlag(
					expectValue(args, ++i, arg),
					arg,
				);
				break;
			case "--local-udp-tx-size":
				request.localUdpTxSize = parseIntFlag(expectValue(args, ++i, arg), arg);
				break;
			case "--remote-udp-tx-size":
				request.remoteUdpTxSize = parseIntFlag(
					expectValue(args, ++i, arg),
					arg,
				);
				break;
			case "--local-tx-speed":
				request.localTxSpeed = parseBandwidth(expectValue(args, ++i, arg), arg);
				break;
			case "--remote-tx-speed":
				request.remoteTxSpeed = parseBandwidth(
					expectValue(args, ++i, arg),
					arg,
				);
				break;
			case "--random-data":
				request.randomData = true;
				break;
			case "--nat-mode":
				request.natMode = true;
				break;
			case "--username":
			case "-u":
			case "--user":
				request.username = expectValue(args, ++i, arg);
				break;
			case "--password":
				request.password = expectValue(args, ++i, arg);
				break;
			case "--port":
				request.controlPort = parseIntFlag(expectValue(args, ++i, arg), arg);
				break;
			case "--cdb-file":
				request.cdbFile = expectValue(args, ++i, arg);
				break;
			case "--cdb-password":
				request.cdbPassword = expectValue(args, ++i, arg);
				break;
			case "--csv":
				parsed.format = "csv";
				break;
			case "--format":
				parsed.format = parseFormat(expectValue(args, ++i, arg));
				break;
			default:
				if (arg.startsWith("-"))
					throw new Error(`Unknown btest client flag: ${arg}`);
				if (request.targetInput !== undefined)
					throw new Error(`Unexpected extra argument: ${arg}`);
				request.targetInput = arg;
		}
	}
	return parsed;
}

function parseServerArgs(args: readonly string[]): ServerCliArgs {
	const request: BtestServerRequest = { env: Bun.env };
	const parsed: ServerCliArgs = { request };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg === "--authenticate" || arg === "--authenticate=true") {
			request.authenticate = true;
			continue;
		}
		if (arg === "--authenticate=false" || arg === "--no-authenticate") {
			request.authenticate = false;
			continue;
		}
		switch (arg) {
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			case "--bind":
				request.bind = expectValue(args, ++i, arg);
				break;
			case "--allocate-udp-ports-from":
				request.allocateUdpPortsFrom = parseIntFlag(
					expectValue(args, ++i, arg),
					arg,
				);
				break;
			case "--max-sessions":
				request.maxSessions = parseIntFlag(expectValue(args, ++i, arg), arg);
				break;
			case "--interval":
				request.intervalMs = parseDuration(expectValue(args, ++i, arg));
				break;
			case "--duration":
				request.durationMs = parseDuration(expectValue(args, ++i, arg));
				break;
			case "--username":
			case "-u":
			case "--user":
				request.username = expectValue(args, ++i, arg);
				break;
			case "--password":
				request.password = expectValue(args, ++i, arg);
				break;
			case "--port":
				request.port = parseIntFlag(expectValue(args, ++i, arg), arg);
				break;
			case "--csv":
				parsed.format = "csv";
				break;
			case "--format":
				parsed.format = parseFormat(expectValue(args, ++i, arg));
				break;
			default:
				if (arg.startsWith("-"))
					throw new Error(`Unknown btest server flag: ${arg}`);
				throw new Error(
					`\`centrs btest server\` takes no positional arguments; got: ${arg}.`,
				);
		}
	}
	return parsed;
}

/** Install a SIGINT→AbortController so an open-ended run stops on Ctrl-C. */
function sigintSignal(): AbortSignal {
	const controller = new AbortController();
	process.once("SIGINT", () => controller.abort());
	return controller.signal;
}

async function runClient(args: readonly string[]): Promise<number> {
	const { help, format = "text", request } = parseClientArgs(args);
	if (help) {
		console.log(renderCommandHelp(describeCentrs(), btestCommand));
		return 0;
	}
	if (request.targetInput === undefined) {
		throw missingTargetError({
			command: "btest client",
			summary: "`centrs btest client` requires a <router> target.",
			remediation:
				"Pass the bandwidth-test server's host/identity, e.g. `centrs btest client 192.0.2.10`.",
		});
	}
	const streaming = format === "text" || format === "csv";
	let csvHeader = false;
	if (streaming) {
		request.onReport = (record) => {
			if (format === "csv") {
				if (!csvHeader) {
					console.log(BTEST_CLIENT_CSV_HEADER);
					csvHeader = true;
				}
				console.log(btestClientCsvRow(record));
			} else {
				console.log(formatBtestReportText(record));
			}
		};
		request.signal = sigintSignal();
	}
	const envelope = await btestClient(request);

	if (format === "json" || format === "yaml") {
		const rendered = renderBtestClientEnvelope(envelope, format);
		if (envelope.ok) console.log(rendered);
		else console.error(rendered);
		return envelope.ok ? 0 : 1;
	}
	// text / csv already streamed live; emit the trailing summary or error.
	if (envelope.ok) {
		if (format === "csv" && !csvHeader) console.log(BTEST_CLIENT_CSV_HEADER);
		if (format === "text") console.log(btestClientSummaryLine(envelope.data));
		return 0;
	}
	if (format === "csv" && !csvHeader) console.log(BTEST_CLIENT_CSV_HEADER);
	console.error(formatCentrsErrorText(envelope.error));
	return 1;
}

async function runServer(args: readonly string[]): Promise<number> {
	const { help, format = "text", request } = parseServerArgs(args);
	if (help) {
		console.log(renderCommandHelp(describeCentrs(), btestCommand));
		return 0;
	}
	const streaming = format === "text" || format === "csv";
	let csvHeader = false;
	if (streaming) {
		request.onSession = (record) => {
			if (format === "csv") {
				if (!csvHeader) {
					console.log(BTEST_SERVER_CSV_HEADER);
					csvHeader = true;
				}
				console.log(btestServerCsvRow(record));
			} else {
				console.log(formatBtestSessionText(record));
			}
		};
	}
	request.signal = sigintSignal();
	const envelope = await btestServer(request);

	if (format === "json" || format === "yaml") {
		const rendered = renderBtestServerEnvelope(envelope, format);
		if (envelope.ok) console.log(rendered);
		else console.error(rendered);
		return envelope.ok ? 0 : 1;
	}
	if (envelope.ok) {
		if (format === "csv" && !csvHeader) console.log(BTEST_SERVER_CSV_HEADER);
		if (format === "text") console.log(btestServerSummaryLine(envelope.data));
		for (const w of envelope.warnings)
			console.error(`warning: [${w.code}] ${w.message}`);
		return 0;
	}
	console.error(formatCentrsErrorText(envelope.error));
	return 1;
}

export async function runBtestCli(args: readonly string[]): Promise<number> {
	try {
		const [sub, ...rest] = args;
		if (sub === undefined || sub === "--help" || sub === "-h") {
			console.log(renderCommandHelp(describeCentrs(), btestCommand));
			return sub === undefined ? 1 : 0;
		}
		if (sub === "client") return await runClient(rest);
		if (sub === "server") return await runServer(rest);
		throw new Error(
			`Unknown btest sub-command: ${sub}. Use \`client <router>\` or \`server\`.`,
		);
	} catch (error) {
		// Text path: full error.message for human readability.
		// JSON/YAML path: fixed summary — never echoes error.message which could
		// carry credentials along the CodeQL js/clear-text-logging data flow.
		const centrsError = asCentrsError(error, {
			code: "input/invalid-command",
			summary: error instanceof Error ? error.message : String(error),
			remediation: "Use `centrs btest --help` to inspect the supported flags.",
		});
		const tips = isMissingTargetError(centrsError)
			? await buildTargetSelectionTips({
					cdbFile: cdbFileFromArgs(args),
					env: Bun.env,
				})
			: [];
		const format = args.includes("--json")
			? "json"
			: args.includes("--yaml")
				? "yaml"
				: "text";
		if (format === "json" || format === "yaml") {
			const safeError = asCentrsError(error, {
				code: "input/invalid-command",
				summary: "btest command failed",
				remediation:
					"Use `centrs btest --help` to inspect the supported flags.",
			});
			const envelope = withTips(
				{ ok: false as const, error: safeError, tips: [] },
				tips,
			);
			console.error(
				format === "yaml" ? toYaml(envelope) : JSON.stringify(envelope),
			);
		} else {
			console.error(formatCentrsErrorText(centrsError) + formatTipsText(tips));
		}
		return 1;
	}
}
