/**
 * Canonical Zod model for a WinBox-CDB **device record**.
 *
 * This is the typed source of truth for a device record — the logical shape that
 * `devices add`/`set` accept and that `buildWinBoxCdbEntryRecord` renders into
 * CDB bytes. The CDB is *one rendering* of this model, not the model itself.
 * Keeping it here — outside prose and the CDB key/value codec — is what lets a
 * future JSON/YAML device representation (JG-19) and the interactive
 * devices-edit TUI (JG-22) share one validated contract.
 *
 * Scope is deliberately **device-records-first** (per the plan): it validates
 * mutation input, stays permissive about target/profile *formats* (a target may
 * be IPv4/IPv6/MAC, optionally `host:port`; a profile may be a `<none>`/own
 * sentinel), and is **lenient about `recordType`** — the CDB decoder preserves
 * record types centrs does not name yet ({@link recordTypeName} → `unknown(N)`),
 * so the model must round-trip them. The strict record-type *name* check stays
 * at the `add` CLI boundary, where a human types a name. Settings and the read
 * (decode) path are out of scope until this layer stays clean.
 */
import { z } from "zod";
import { winBoxCdbRecordType } from "./data/winbox-cdb.ts";
import { CentrsError } from "./errors.ts";

/** Record-type names a human can supply (the strict, user-facing set). */
export const recordTypeNames: readonly string[] =
	Object.keys(winBoxCdbRecordType);

/** True when `value` is a record type centrs names (vs. a preserved unknown). */
export function isKnownRecordType(value: number): boolean {
	return (Object.values(winBoxCdbRecordType) as number[]).includes(value);
}

/**
 * The logical device record. Field semantics mirror `commands/devices/README.md`
 * and the WinBox CDB field tags (`src/data/winbox-cdb.ts`).
 */
export const deviceRecordSchema = z.object({
	/**
	 * WinBox CDB record-type tag. Lenient (non-negative int) so a decoded record
	 * with a not-yet-named type round-trips; {@link isKnownRecordType} is the
	 * strict check for user-supplied types.
	 */
	recordType: z.number().int().nonnegative(),
	/**
	 * Address or MAC (optionally `host:port`); the record's natural identity with
	 * `user`. Must be non-blank.
	 */
	target: z
		.string()
		.refine(
			(s) => s.trim().length > 0,
			"a device record needs a non-blank target",
		),
	user: z.string().optional(),
	password: z.string().optional(),
	session: z.string().optional(),
	comment: z.string().optional(),
	group: z.string().optional(),
	profile: z.string().optional(),
	savedPassword: z.boolean().optional(),
});

export type DeviceRecord = z.infer<typeof deviceRecordSchema>;

function remediationFor(field: string): string {
	switch (field) {
		case "target":
			return "Pass a non-blank address or MAC (optionally host:port) as the target.";
		case "recordType":
			return `Record type must be a non-negative integer; the named types are ${recordTypeNames.join(", ")}.`;
		default:
			return "Check the device-record field types: strings for user/password/session/comment/group/profile, a boolean for savedPassword.";
	}
}

/**
 * Validate a logical device record, returning the typed value or throwing a
 * `cdb/invalid-record` {@link CentrsError}. The mutation path (`addDevice`,
 * `setDevice`) runs this before rendering to CDB, so a malformed record (blank
 * target, wrong field type) fails with an actionable error for *every* caller —
 * CLI, MCP, and a future JSON/YAML import — not just the CLI's own guards.
 */
export function parseDeviceRecord(input: unknown): DeviceRecord {
	const result = deviceRecordSchema.safeParse(input);
	if (result.success) {
		return result.data;
	}
	const issue = result.error.issues[0];
	const field = issue?.path.join(".") || "(record)";
	throw new CentrsError({
		code: "cdb/invalid-record",
		summary: `Invalid device record: ${field} — ${issue?.message ?? "failed validation"}.`,
		remediation: remediationFor(field),
		context: { field },
	});
}
