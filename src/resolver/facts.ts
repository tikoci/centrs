/**
 * Device-class fact extraction + selector matching, shared by the fan-out
 * resolver ({@link ../resolver/selection.ts | expandSelection}) and
 * `devices list` (`src/devices.ts`) so **both surfaces match `--where` /
 * `--near` / `--bbox` against identical semantics**.
 *
 * This is a deliberate leaf module — it imports only from `comment-kv.ts`,
 * `mac.ts`, and `geo.ts` (all leaves). It exists because `src/devices.ts` and
 * `src/resolver/cdb.ts` form a cycle (`cdb.ts` imports `devices.ts`), so
 * `devices.ts` cannot import `cdb.ts`'s `identityFromComment`/`macFromComment`
 * nor `selection.ts`'s local `entryFacts` without a circular import. That forced
 * the `--where` fact-builder to be duplicated in both files; hosting it here
 * removes the duplication and the "keep the two in sync" hazard.
 */

import { parseCommentKv, parseRawCommentFacts } from "./comment-kv.ts";
import {
	canonicalizeGeoKey,
	type DeviceLocation,
	deviceLocation,
} from "./geo.ts";
import { normalizeMac } from "./mac.ts";

/** One exact-match device-class clause (`attr=value`), AND-combined by callers. */
export interface WhereClause {
	key: string;
	value: string;
}

/**
 * Turn a CDB entry's `(comment, target, group)` into the device-class fact map
 * `--where` matches against: every raw comment-kv token, with the core fields
 * (`target`/`identity`/`group`/`mac`) layered **on top** so a hand-written
 * comment token can never spoof a first-class field. MAC is normalized so a
 * `mac=` lookup or a MAC `target` compares separator/case-insensitively.
 */
export function entryFacts(
	comment: string,
	target: string,
	group: string,
): Record<string, string> {
	const facts = parseRawCommentFacts(comment);
	const lookups = parseCommentKv(comment).lookups;
	facts["target"] = target;
	facts["identity"] = lookups.identity ?? target;
	facts["group"] = group;
	const mac = normalizeMac(lookups.mac ?? "") ?? normalizeMac(target);
	if (mac !== undefined) {
		facts["mac"] = mac;
	}
	return facts;
}

/**
 * True when every `--where` clause matches the entry's facts (exact,
 * AND-combined). The clause key is run through {@link canonicalizeGeoKey} here —
 * the single seam — so a geo alias (`--where latitude=…`/`lng=…`/`elevation=…`)
 * matches the canonical `lat`/`lon`/`altitude` fact the write side stores, on
 * BOTH `devices list` and every fan-out command's `--where`. A no-op for
 * non-geo keys.
 */
export function matchesWhere(
	facts: Record<string, string>,
	where: readonly WhereClause[],
): boolean {
	return where.every(
		(clause) => facts[canonicalizeGeoKey(clause.key)] === clause.value,
	);
}

/**
 * Read a CDB entry's GPS location from its comment, or `undefined` when it
 * carries no well-formed `lat`/`lon`. The single seam `--near`/`--bbox` use to
 * exclude geo-less devices (never an error — they simply don't match).
 */
export function entryLocation(comment: string): DeviceLocation | undefined {
	return deviceLocation(parseRawCommentFacts(comment));
}
