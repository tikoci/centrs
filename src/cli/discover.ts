/**
 * `centrs discover` CLI surface: command metadata, arg parsing, dispatch, and
 * error-to-envelope rendering. `discover` listens for MNDP neighbor
 * announcements and, with `--save`, persists them into the CDB through the
 * shared `devices` write layer.
 */

import {
	type DiscoverOptions,
	type DiscoverOutputFormat,
	discover,
	discoverOutputFormats,
	renderDiscoverEnvelope,
} from "../discover.ts";
import { asCentrsError, formatCentrsErrorText } from "../errors.ts";
import { describeCentrs, parseDuration } from "../index.ts";
import {
	type CliCommandMetadata,
	expectValue,
	renderCommandHelp,
} from "./common.ts";

export const discoverCommand: CliCommandMetadata = {
	name: "discover",
	usage: "centrs discover [--timeout 60s] [--save] [flags]",
	summary:
		"Discover RouterOS neighbors over MNDP and optionally save them into the CDB.",
	options: [
		{
			flag: "--timeout",
			valueName: "<ms|60s>",
			description: "Listen window before results are returned. Default 60s.",
		},
		{
			flag: "--save",
			description:
				"Persist discovered neighbors into the CDB (`group=discovered`, `source=mndp`).",
		},
		{
			flag: "--group",
			valueName: "<name>",
			description: "`--save` group for new entries. Default `discovered`.",
		},
		{
			flag: "--port",
			valueName: "<port>",
			description: "UDP port to bind for MNDP. Default 5678.",
		},
		{
			flag: "--cdb-file",
			valueName: "<path>",
			description:
				"`--save` CDB path override (default `~/.config/tikoci/winbox.cdb`).",
		},
		{
			flag: "--cdb-password",
			valueName: "<secret>",
			description:
				"`--save` password for an encrypted CDB. Encrypted CDBs are read-only.",
		},
		{
			flag: "--format",
			valueName: `<${discoverOutputFormats.join("|")}>`,
			description: "Output format for the CLI response.",
		},
		{
			flag: "--json",
			description: "Shortcut for `--format json`.",
		},
	],
};

interface DiscoverCliArgs {
	help?: boolean;
	timeoutMs?: number;
	save?: boolean;
	group?: string;
	port?: number;
	cdbFile?: string;
	cdbPassword?: string;
	format?: DiscoverOutputFormat;
}

function parseDiscoverCliArgs(args: readonly string[]): DiscoverCliArgs {
	const parsed: DiscoverCliArgs = {};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
			continue;
		}
		switch (arg) {
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			case "--timeout":
				parsed.timeoutMs = parseDuration(expectValue(args, ++index, arg));
				break;
			case "--save":
				parsed.save = true;
				break;
			case "--group":
				parsed.group = expectValue(args, ++index, arg);
				break;
			case "--port": {
				const value = expectValue(args, ++index, arg);
				const port = Number.parseInt(value, 10);
				if (!Number.isInteger(port) || port < 0 || port > 65535) {
					throw new Error(`--port must be an integer 0-65535; got ${value}.`);
				}
				parsed.port = port;
				break;
			}
			case "--cdb-file":
				parsed.cdbFile = expectValue(args, ++index, arg);
				break;
			case "--cdb-password":
				parsed.cdbPassword = expectValue(args, ++index, arg);
				break;
			case "--format": {
				const value = expectValue(args, ++index, arg);
				if (!discoverOutputFormats.includes(value as DiscoverOutputFormat)) {
					throw new Error(
						`--format must be one of ${discoverOutputFormats.join(", ")}; got ${value}.`,
					);
				}
				parsed.format = value as DiscoverOutputFormat;
				break;
			}
			case "--json":
				parsed.format = "json";
				break;
			default:
				if (arg.startsWith("-")) {
					throw new Error(`Unknown discover flag: ${arg}`);
				}
				throw new Error(
					`\`centrs discover\` does not accept positional arguments; got: ${arg}.`,
				);
		}
	}
	return parsed;
}

export async function runDiscoverCli(args: readonly string[]): Promise<number> {
	let parsed: DiscoverCliArgs | undefined;
	try {
		parsed = parseDiscoverCliArgs(args);
		if (parsed.help) {
			console.log(renderCommandHelp(describeCentrs(), discoverCommand));
			return 0;
		}

		const options: DiscoverOptions = {
			timeoutMs: parsed.timeoutMs,
			save: parsed.save,
			group: parsed.group,
			port: parsed.port,
			cdbFile: parsed.cdbFile,
			cdbPassword: parsed.cdbPassword,
			env: Bun.env,
		};
		const envelope = await discover(options);
		const format = parsed.format ?? "text";
		const rendered = renderDiscoverEnvelope(envelope, format);
		if (envelope.ok) {
			console.log(rendered);
			return 0;
		}
		console.error(
			format === "json" || format === "yaml"
				? rendered
				: formatCentrsErrorText(envelope.error),
		);
		return 1;
	} catch (error) {
		const centrsError = asCentrsError(error, {
			code: "input/invalid-command",
			summary: error instanceof Error ? error.message : String(error),
			remediation:
				"Use `centrs discover --help` to inspect the supported flags.",
		});
		console.error(formatCentrsErrorText(centrsError));
		return 1;
	}
}
