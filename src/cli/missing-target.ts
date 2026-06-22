/**
 * Shared "no `<router>` target" guidance for the CLI surfaces.
 *
 * Every command that takes a `<router>` (terminal, execute, retrieve, transfer,
 * btest client) raises the same `input/invalid-command` error when the target is
 * missing, tagged with `context.missingTarget`. Each runner then calls
 * {@link buildTargetSelectionTips} to turn that bare usage error into actionable
 * advice: list a few saved CDB devices to pass as `<router>`, or — when the
 * registry is empty — point at `centrs discover --save`. Tips ride the envelope's
 * `tips` channel (`docs/CONSTITUTION.md` → Result envelope); this module also
 * renders them for the **text** error path, which `formatCentrsErrorText` does
 * not surface on its own.
 */

import { buildTip, type Tip } from "../core/envelope.ts";
import { defaultCdbPath, loadCdb } from "../devices.ts";
import { CentrsError } from "../errors.ts";
import { DEFAULT_RECORD_TARGET, identityFromComment } from "../resolver/cdb.ts";

/** Cap on how many saved devices a single tip names before "(+N more)". */
const MAX_LISTED_DEVICES = 8;

export interface MissingTargetErrorInit {
	command: string;
	summary: string;
	remediation: string;
}

/**
 * The canonical "missing `<router>`" usage error. The `context.missingTarget`
 * flag is the marker {@link isMissingTargetError} keys on so a runner knows to
 * attach {@link buildTargetSelectionTips} output.
 */
export function missingTargetError(init: MissingTargetErrorInit): CentrsError {
	return new CentrsError({
		code: "input/invalid-command",
		summary: init.summary,
		remediation: init.remediation,
		context: { missingTarget: true, command: init.command },
	});
}

/** True for an error raised by {@link missingTargetError} (or one tagged like it). */
export function isMissingTargetError(error: unknown): boolean {
	return (
		error instanceof CentrsError && error.context?.["missingTarget"] === true
	);
}

export interface CdbInputs {
	cdbFile?: string;
	env?: Record<string, string | undefined>;
}

/**
 * Pull the `--cdb-file` path out of raw args. Used by catch paths where the
 * request never finished parsing (the missing-target throw happens mid-parse),
 * so the request object is unavailable but the flag may still be on the command
 * line. The CDB *password* is deliberately not extracted: a credential must
 * never flow into the (logged) tip path, and the tips read only an unencrypted
 * registry — an encrypted CDB falls back to generic guidance.
 */
export function cdbFileFromArgs(args: readonly string[]): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--cdb-file") {
			return args[index + 1];
		}
	}
	return undefined;
}

/**
 * Best-effort: inspect the CDB and turn "no `<router>`" into actionable tips —
 * a list of saved targets when the registry has any, otherwise a pointer to
 * `discover --save`. Never throws: an unreadable/encrypted CDB falls back to
 * generic guidance, and a missing default CDB is reported as an empty registry
 * (no file is created as a side effect of a usage error). The CDB password is
 * intentionally never read here, so no credential can reach the rendered tip.
 */
export async function buildTargetSelectionTips(
	inputs: CdbInputs,
): Promise<Tip[]> {
	const env = inputs.env ?? {};
	const explicitCdb =
		inputs.cdbFile !== undefined || env["CENTRS_CDB_FILE"] !== undefined;
	if (!explicitCdb && !(await Bun.file(defaultCdbPath(env)).exists())) {
		return [emptyRegistryTip()];
	}

	let entries: readonly { target: string; comment: string }[];
	try {
		const cdb = await loadCdb({
			cdbFile: inputs.cdbFile,
			env,
		});
		entries = cdb.entries.filter(
			(entry) =>
				entry.target.length > 0 && entry.target !== DEFAULT_RECORD_TARGET,
		);
	} catch {
		return [unreadableRegistryTip()];
	}

	if (entries.length === 0) {
		return [emptyRegistryTip()];
	}

	const handles = entries
		.slice(0, MAX_LISTED_DEVICES)
		.map((entry) => identityFromComment(entry.comment, entry.target));
	const extra =
		entries.length > MAX_LISTED_DEVICES
			? ` (+${entries.length - MAX_LISTED_DEVICES} more)`
			: "";
	return [
		buildTip(
			"tip/select-target",
			`Pass one of your ${entries.length} saved device(s) as <router>: ${handles.join(", ")}${extra}.`,
			"Run `centrs devices list` for every saved target; <router> also resolves by identity=, mac=, or ip=.",
		),
	];
}

function emptyRegistryTip(): Tip {
	return buildTip(
		"tip/no-devices",
		"No devices are saved in the CDB yet.",
		"Run `centrs discover --save` to find RouterOS neighbors on the LAN and add them, then pass one as <router> (or `centrs devices add <target> --user … --password …`).",
	);
}

function unreadableRegistryTip(): Tip {
	return buildTip(
		"tip/select-target",
		"Could not read the CDB to list saved devices (it may be encrypted — pass --cdb-password).",
		"Run `centrs devices list` to see saved targets, or `centrs discover --save` to find and add neighbors on the LAN.",
	);
}

/**
 * Render tips for the **text** error path (mirrors the `devices` "Tips:"
 * footer). Returns "" for an empty list so callers can append unconditionally.
 */
export function formatTipsText(tips: readonly Tip[]): string {
	if (tips.length === 0) {
		return "";
	}
	const lines = ["", "Tips:"];
	for (const tip of tips) {
		lines.push(`  - [${tip.code}] ${tip.message}`);
		if (tip.fix) {
			lines.push(`    fix: ${tip.fix}`);
		}
	}
	return lines.join("\n");
}

/**
 * Return a copy of an envelope with `tips` attached (no-op for an empty list).
 * The `as E` keeps the call site's envelope type when an error envelope declares
 * `tips: []` (an empty tuple) — we only ever widen it to a populated list.
 */
export function withTips<E extends { tips: readonly Tip[] }>(
	envelope: E,
	tips: readonly Tip[],
): E {
	return tips.length > 0 ? ({ ...envelope, tips } as E) : envelope;
}
