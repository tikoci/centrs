/**
 * `centrs --version` / `-V` (#463): the package version, for scripts, agents and
 * field reports.
 *
 * Text output is the bare version string (`0.1.9-next.0`), so a script can use
 * it as is. `--json` / `--format json|yaml` return the standard envelope with
 * `data.version`. Format comes from flags only, never `CENTRS_FORMAT`, so a
 * plain `centrs --version` always prints the bare string.
 */

import type { CentrsEnvelope } from "../core/envelope.ts";
import { centrsVersion } from "../core/version.ts";
import { toYaml } from "../core/yaml.ts";
import { CentrsError, formatCentrsErrorText } from "../errors.ts";

const versionFormats = ["text", "json", "yaml"] as const;
type VersionFormat = (typeof versionFormats)[number];

export type VersionEnvelope = CentrsEnvelope<
	{ version: string },
	{ command: "version" }
>;

export function versionEnvelope(): VersionEnvelope {
	return {
		ok: true,
		data: { version: centrsVersion },
		warnings: [],
		tips: [],
		meta: {
			target: {},
			via: null,
			settings: {},
			operation: { command: "version" },
		},
	};
}

function parseVersionFormat(args: readonly string[]): VersionFormat {
	let format: VersionFormat = "text";
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--json") {
			format = "json";
		} else if (arg === "--yaml") {
			format = "yaml";
		} else if (arg === "--format") {
			const value = args[++index];
			if (!versionFormats.includes(value as VersionFormat)) {
				throw new CentrsError({
					code: "settings/invalid-format",
					summary: `--format must be one of ${versionFormats.join(", ")}; got ${value ?? "(missing)"}.`,
					remediation: `Choose one of ${versionFormats.join(", ")}.`,
					context: { format: value },
				});
			}
			format = value as VersionFormat;
		} else {
			throw new CentrsError({
				code: "input/invalid-command",
				summary: `\`centrs --version\` takes only an output format; got ${arg}.`,
				remediation:
					"Run `centrs --version`, or `centrs --version --json` for the envelope.",
				context: { arg },
			});
		}
	}
	return format;
}

export function runVersionCli(args: readonly string[]): number {
	let format: VersionFormat;
	try {
		format = parseVersionFormat(args);
	} catch (error) {
		console.error(formatCentrsErrorText(error as CentrsError));
		return 1;
	}
	if (format === "json") {
		console.log(JSON.stringify(versionEnvelope(), null, 2));
	} else if (format === "yaml") {
		console.log(toYaml(versionEnvelope()));
	} else {
		console.log(centrsVersion);
	}
	return 0;
}
