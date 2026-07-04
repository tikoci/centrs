/**
 * Target-selection grammar (the full fan-out selector).
 *
 * Generalizes `expandCdbGroup` (a single `--group`) into the constitution's
 * one grammar for every non-terminal command: `<router>` positionals (one or
 * more), repeatable `--group`, `--all` (every CDB record), `--default` (the
 * reserved `__default__` record), and repeatable `--where <attr>=<value>` (a
 * device-class selector over CDB facts + core fields). The union is de-duped by
 * CDB record index (literals by normalized input) and ordered by record index so
 * repeated runs diff cleanly (see `docs/CONSTITUTION.md`, Target selection).
 *
 * Boundaries this module is careful about:
 *   - The CDB is loaded + decrypted ONCE for the whole expansion.
 *   - A positional is matched against the already-loaded entries with
 *     {@link showDevice} (the identity matcher), NOT `resolveCdb` — `resolveCdb`
 *     re-loads the CDB and, when a `__default__` record exists, returns a
 *     synthetic resolution for ANY unmatched target, which would collide two
 *     distinct ad-hoc literals on the default record's index. A non-matching
 *     positional stays a literal (de-duped by input); default credentials are
 *     applied later by the per-target resolver, not here.
 *   - `--all` / `--group` / `--where` never include the `__default__` record (it
 *     is a credential-fallback record, not a fleet member). Only `--default` (or
 *     an explicit `__default__` positional) selects it; the per-target resolver
 *     guards it from being dialed as the literal hostname `"__default__"`.
 *   - `allowAdhoc` is the surface policy: CLI passes `true` (literal positionals
 *     allowed); MCP passes `false`, so an unregistered literal is rejected with
 *     `cdb/target-not-registered` and selection cannot widen the CDB allowlist.
 */

import {
	type LoadedCdb,
	loadCdb,
	resolveDevicesSettings,
	showDevice,
} from "../devices.ts";
import { CentrsError } from "../errors.ts";
import {
	type CdbResolution,
	DEFAULT_RECORD_TARGET,
	type ResolverWarning,
	resolutionFromEntry,
} from "./cdb.ts";
import { entryFacts, entryLocation, matchesWhere } from "./facts.ts";
import {
	type BboxPredicate,
	matchesBbox,
	matchesNear,
	type NearPredicate,
} from "./geo.ts";

/** One `--where attr=value` device-class clause (exact-match, AND-combined). */
export interface SelectionWhereClause {
	key: string;
	value: string;
}

/** The parsed target selection a command hands to {@link expandCdbSelection}. */
export interface TargetSelection {
	/** Literal/lookup positionals (NOT operation args — the caller splits those). */
	positionals: readonly string[];
	/** Repeatable `--group <name>`. */
	groups: readonly string[];
	/** `--all`: every CDB record except `__default__`. */
	all: boolean;
	/** `--default`: the reserved `__default__` record. */
	default: boolean;
	/** Repeatable `--where attr=value`, AND-combined. */
	where: readonly SelectionWhereClause[];
	/** `--near <lat>,<lon>,<radius>`: a geo union predicate (device GPS within radius). */
	near?: NearPredicate;
	/** `--bbox <south>,<west>,<north>,<east>`: a geo union predicate (device GPS in box). */
	bbox?: BboxPredicate;
}

export interface CdbSelectionResolveInput {
	cdbFile?: string;
	cdbPassword?: string;
	/** CLI: true (literal positionals allowed). MCP: false (CDB is the allowlist). */
	allowAdhoc: boolean;
}

/** One resolved selection member: a CDB record or an ad-hoc literal target. */
export type CdbSelectionMember =
	| { kind: "cdb"; resolution: CdbResolution; recordIndex: number }
	| { kind: "literal"; input: string };

export interface CdbSelectionExpansion {
	/** Members ordered by record index; literals appended in positional order. */
	targets: readonly CdbSelectionMember[];
	warnings: readonly ResolverWarning[];
	/** True when nothing matched (an empty/unknown selection is not an error). */
	empty: boolean;
}

/** True when a resolved target is the reserved credential-fallback record. */
export function isDefaultRecordTarget(target: string): boolean {
	return target === DEFAULT_RECORD_TARGET;
}

const ENV_CDB_FILE = "CENTRS_CDB_FILE";
const ENV_CDB_PASSWORD = "CENTRS_CDB_PASSWORD";

/**
 * Expand a {@link TargetSelection} into N resolved members. The CDB is loaded
 * once; selectors and positionals union into a record-index set (plus literals),
 * de-duped, ordered by record index. Empty/unknown selection → `empty: true`
 * with a warning, never an error. A decrypt/parse failure throws (the fan-out's
 * outer envelope reports it).
 *
 * When no CDB exists and none was requested explicitly, the expansion proceeds
 * over an empty registry — so a pure-literal selection (`api r1 r2 …`) still
 * fans out (mirroring single-target `resolveCdb`, which treats a `<router>` as a
 * literal host when no CDB is present). An explicit `--cdb-file` that is missing
 * still throws.
 */
export async function expandCdbSelection(
	selection: TargetSelection,
	input: CdbSelectionResolveInput,
	env: Record<string, string | undefined>,
	config: Record<string, string | undefined> = {},
): Promise<CdbSelectionExpansion> {
	const settings = resolveDevicesSettings({
		cdbFile: input.cdbFile,
		cdbPassword: input.cdbPassword,
		env,
		config,
	});
	const explicitCdb =
		input.cdbFile !== undefined ||
		input.cdbPassword !== undefined ||
		env[ENV_CDB_FILE] !== undefined ||
		env[ENV_CDB_PASSWORD] !== undefined ||
		config[ENV_CDB_FILE] !== undefined;
	const emptyCdb = (): LoadedCdb => ({
		entries: [],
		warnings: [],
		encrypted: false,
		settings,
	});
	let cdb: LoadedCdb;
	// Mirror `resolveCdb`: an absent, non-explicit default CDB is an empty registry,
	// NOT an error and NOT a freshly created file (`loadCdb` would create one).
	if (!explicitCdb && !(await Bun.file(settings.cdbFile.value).exists())) {
		cdb = emptyCdb();
	} else {
		try {
			cdb = await loadCdb({
				cdbFile: input.cdbFile,
				cdbPassword: input.cdbPassword,
				env,
				config,
			});
		} catch (error) {
			if (
				!explicitCdb &&
				error instanceof CentrsError &&
				error.code === "cdb/not-found"
			) {
				cdb = emptyCdb();
			} else {
				throw error;
			}
		}
	}
	const warnings: ResolverWarning[] = cdb.warnings.map((warning) => ({
		code: warning.code,
		message: warning.message,
		context: warning.context,
	}));

	const groupSet = new Set(selection.groups);
	const indices = new Set<number>();

	for (let index = 0; index < cdb.entries.length; index += 1) {
		const entry = cdb.entries[index];
		if (!entry || entry.target === DEFAULT_RECORD_TARGET) {
			continue;
		}
		if (selection.all) {
			indices.add(index);
			continue;
		}
		if (groupSet.size > 0 && groupSet.has(entry.group)) {
			indices.add(index);
			continue;
		}
		if (
			selection.where.length > 0 &&
			matchesWhere(
				entryFacts(entry.comment, entry.target, entry.group),
				selection.where,
			)
		) {
			indices.add(index);
			continue;
		}
		// Geo predicates are additional OR-union terms (like `--group`/`--where`):
		// an entry matches when its GPS falls in `--near`'s radius OR `--bbox`.
		// Geo-less entries carry no location, so they never match (not an error).
		if (selection.near !== undefined || selection.bbox !== undefined) {
			const loc = entryLocation(entry.comment);
			if (
				loc !== undefined &&
				((selection.near !== undefined && matchesNear(loc, selection.near)) ||
					(selection.bbox !== undefined && matchesBbox(loc, selection.bbox)))
			) {
				indices.add(index);
			}
		}
	}

	if (selection.default) {
		const defaultIndex = cdb.entries.findIndex(
			(entry) => entry?.target === DEFAULT_RECORD_TARGET,
		);
		if (defaultIndex >= 0) {
			indices.add(defaultIndex);
		} else {
			warnings.push({
				code: "cdb/empty-selection",
				message: "No `__default__` record exists to select with `--default`.",
				context: { selector: "--default" },
			});
		}
	}

	const literals: CdbSelectionMember[] = [];
	const seenLiteral = new Set<string>();
	for (const positional of selection.positionals) {
		try {
			const shown = showDevice({ cdb, target: positional });
			indices.add(shown.data.entry.cdbRecordIndex);
		} catch (error) {
			if (
				error instanceof CentrsError &&
				error.code === "cdb/not-found-target"
			) {
				if (!input.allowAdhoc) {
					throw new CentrsError({
						code: "cdb/target-not-registered",
						summary: `"${positional}" is not a registered CDB target.`,
						remediation:
							"Register the device with `centrs devices add`, or select registered targets via `--group` / `--where` / `--all`.",
						context: { target: positional },
					});
				}
				const key = positional.trim().toLowerCase();
				if (!seenLiteral.has(key)) {
					seenLiteral.add(key);
					literals.push({ kind: "literal", input: positional });
				}
				continue;
			}
			throw error;
		}
	}

	const cdbMembers: CdbSelectionMember[] = [...indices]
		.sort((a, b) => a - b)
		.map((index) => ({
			kind: "cdb",
			resolution: resolutionFromEntry(
				cdb.entries[index] as NonNullable<(typeof cdb.entries)[number]>,
				index,
			),
			recordIndex: index,
		}));

	const targets = [...cdbMembers, ...literals];
	if (targets.length === 0) {
		const groupOnly =
			groupSet.size > 0 &&
			selection.positionals.length === 0 &&
			!selection.all &&
			!selection.default &&
			selection.where.length === 0 &&
			selection.near === undefined &&
			selection.bbox === undefined;
		warnings.push(
			groupOnly
				? {
						code: "cdb/empty-group",
						message: `No CDB entries matched group ${[...groupSet].map((g) => `"${g}"`).join(", ")}.`,
						context: { groups: [...groupSet] },
					}
				: {
						code: "cdb/empty-selection",
						message: "The target selection matched no CDB records.",
						context: {
							groups: [...groupSet],
							all: selection.all,
							default: selection.default,
							where: selection.where.length,
							near: selection.near !== undefined,
							bbox: selection.bbox !== undefined,
							positionals: selection.positionals.length,
						},
					},
		);
		return { targets: [], warnings, empty: true };
	}

	return { targets, warnings, empty: false };
}
