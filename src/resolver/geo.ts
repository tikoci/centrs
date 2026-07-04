/**
 * Device GPS: lat/lon/altitude parsing, validation, and alias canonicalization
 * (centrs issue #146, Slice 1 — storage + validation + envelope + exact
 * `--where`).
 *
 * Coordinates are stored as comment-kv facts (`lat`, `lon`, `altitude`,
 * `altitude-type`) — see `commands/devices/README.md` (Location / GPS) and
 * `docs/CONSTITUTION.md`. This module owns:
 *
 *   - alias canonicalization ({@link canonicalizeGeoKey}: `lng`/`longitude`/
 *     `long` -> `lon`, `latitude` -> `lat`, `alt`/`elevation` -> `altitude`) so
 *     the canonical key is what lands in the comment and the envelope,
 *   - range/enum validation (`input/invalid-coordinate`,
 *     `input/invalid-altitude`), and
 *   - the `--gps <lat>,<lon>[,<altitude>[,<altitude-type>]]` combined-flag
 *     shape (`input/incomplete-gps` on wrong arity).
 *
 * **Coordinate order is lat-first everywhere** (ISO 6709 / EPSG:4326
 * authority order, matching Google Maps / Leaflet / most GPS devices) — the
 * opposite of GeoJSON's lon-first order (RFC 7946 itself calls swapping them
 * "the most common GeoJSON bug"). A lat-first `--gps 37.77,-122.41` is what an
 * agent guesses from the flag name; GeoJSON's lon-first order is deliberately
 * out of scope for this bare-CSV surface.
 *
 * Values are stored **verbatim as typed** (validated, not reformatted) so an
 * exact `--where lat=<value>` still matches what was written; `altitude-type`
 * is the one exception — it is a closed two-value enum, so it is normalized to
 * upper case (`msl` -> `MSL`) before storage. Pairing (`lat`/`lon` set
 * together) needs both the incoming updates and the record's prior comment, so
 * it is validated in `src/devices.ts` (`validateCommentKvUpdates`), which
 * calls the pure primitives here; this module has no CDB/record awareness.
 *
 * Slice 2 (`--near`/`--bbox`, haversine/bbox query predicates) adds the query
 * helpers to this same file; they are out of scope here.
 */

import { CentrsError } from "../errors.ts";

/** Vertical datum for a stored altitude. */
export type AltitudeType = "MSL" | "AGL";

/** A device's parsed GPS location, read from comment-kv facts. */
export interface DeviceLocation {
	lat: number;
	lon: number;
	altitude?: number;
	altitudeType?: AltitudeType;
}

/**
 * Alias -> canonical key map for the geo comment-kv fields. `altitude-type`
 * has no alias (only its flag does, `--alt-type`, which maps directly to the
 * canonical key at the CLI layer). Applied in ONE place —
 * {@link canonicalizeGeoKey} — so both `--flag` lowering and bare `k=v`
 * positionals agree on the canonical key that lands in storage.
 */
const GEO_KEY_ALIASES: Readonly<Record<string, "lat" | "lon" | "altitude">> = {
	lat: "lat",
	latitude: "lat",
	lon: "lon",
	lng: "lon",
	longitude: "lon",
	long: "lon",
	altitude: "altitude",
	alt: "altitude",
	elevation: "altitude",
};

/**
 * Canonicalize a comment-kv key alias (case-insensitive) to its stored form.
 * A key with no known alias is returned unchanged (original casing preserved),
 * so this is safe to apply to every bare `k=v` token, not just geo ones.
 */
export function canonicalizeGeoKey(key: string): string {
	return GEO_KEY_ALIASES[key.toLowerCase()] ?? key;
}

/** Parse a raw string to a finite number, or `undefined` for NaN/empty/whitespace-only input. */
function toFiniteNumber(value: string): number | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

const COORDINATE_RANGE: Readonly<
	Record<"lat" | "lon", { min: number; max: number }>
> = {
	lat: { min: -90, max: 90 },
	lon: { min: -180, max: 180 },
};

/**
 * Validate a latitude (`kind: "lat"`, range `[-90, 90]`) or longitude
 * (`kind: "lon"`, range `[-180, 180]`) string, throwing
 * `input/invalid-coordinate` on NaN or out-of-range. Returns the parsed
 * number; storage keeps the original string verbatim (see module doc-comment).
 */
export function parseLatLon(value: string, kind: "lat" | "lon"): number {
	const range = COORDINATE_RANGE[kind];
	const parsed = toFiniteNumber(value);
	if (parsed === undefined || parsed < range.min || parsed > range.max) {
		const label = kind === "lat" ? "latitude" : "longitude";
		throw new CentrsError({
			code: "input/invalid-coordinate",
			summary: `Invalid ${label} "${value}"; must be a number between ${range.min} and ${range.max}.`,
			remediation:
				kind === "lat"
					? "Pass a decimal-degrees latitude in [-90, 90], e.g. --lat 37.7749."
					: "Pass a decimal-degrees longitude in [-180, 180], e.g. --lon -122.4194.",
			context: { key: kind, value },
		});
	}
	return parsed;
}

/** Validate an altitude (meters, may be negative), throwing `input/invalid-altitude` on NaN. */
export function parseAltitude(value: string): number {
	const parsed = toFiniteNumber(value);
	if (parsed === undefined) {
		throw new CentrsError({
			code: "input/invalid-altitude",
			summary: `Invalid altitude "${value}"; must be a number (meters).`,
			remediation:
				"Pass altitude in meters, e.g. --altitude 120 (negative values are allowed below sea level).",
			context: { key: "altitude", value },
		});
	}
	return parsed;
}

/**
 * Validate + canonicalize an altitude-type value (case-insensitive), throwing
 * `input/invalid-altitude` for anything other than `MSL`/`AGL`. Returns the
 * upper-cased canonical form — the one geo field normalized for storage, since
 * it is a closed two-value enum rather than freeform/numeric.
 */
export function parseAltitudeType(value: string): AltitudeType {
	const upper = value.trim().toUpperCase();
	if (upper === "MSL" || upper === "AGL") {
		return upper;
	}
	throw new CentrsError({
		code: "input/invalid-altitude",
		summary: `Invalid altitude-type "${value}"; must be MSL or AGL.`,
		remediation:
			"Use --altitude-type MSL (mean sea level, the default) or AGL (above ground level).",
		context: { key: "altitude-type", value },
	});
}

/**
 * {@link parseGpsTuple}'s validated result: parsed numbers plus the original,
 * untouched substrings for verbatim-as-typed storage.
 */
export interface ParsedGpsTuple {
	lat: number;
	lon: number;
	altitude?: number;
	altitudeType?: AltitudeType;
	/**
	 * The original (trimmed) substrings, for verbatim storage. `altitudeType`
	 * here is already canonical-cased since it is a closed enum, not a
	 * freeform/numeric value.
	 */
	raw: {
		lat: string;
		lon: string;
		altitude?: string;
		altitudeType?: string;
	};
}

/**
 * Parse the `--gps <lat>,<lon>[,<altitude>[,<altitude-type>]]` combined-flag
 * shape (lat-first — see module doc-comment). Requires 2-4 non-empty
 * comma-separated parts, throwing `input/incomplete-gps` otherwise. A missing
 * altitude-type in the 3-part form defaults to `MSL`.
 */
export function parseGpsTuple(value: string): ParsedGpsTuple {
	const parts = value.split(",").map((part) => part.trim());
	if (
		parts.length < 2 ||
		parts.length > 4 ||
		parts.some((part) => part.length === 0)
	) {
		throw new CentrsError({
			code: "input/incomplete-gps",
			summary: `--gps "${value}" must be <lat>,<lon>[,<altitude>[,<altitude-type>]].`,
			remediation:
				"Pass at least lat,lon (e.g. --gps 37.7749,-122.4194), optionally followed by altitude and MSL|AGL.",
			context: { gps: value },
		});
	}
	const [rawLat, rawLon, rawAltitude, rawAltitudeType] = parts as [
		string,
		string,
		string?,
		string?,
	];
	const lat = parseLatLon(rawLat, "lat");
	const lon = parseLatLon(rawLon, "lon");
	const result: ParsedGpsTuple = {
		lat,
		lon,
		raw: { lat: rawLat, lon: rawLon },
	};
	if (rawAltitude !== undefined) {
		result.altitude = parseAltitude(rawAltitude);
		result.raw.altitude = rawAltitude;
		result.altitudeType =
			rawAltitudeType !== undefined
				? parseAltitudeType(rawAltitudeType)
				: "MSL";
		result.raw.altitudeType = result.altitudeType;
	}
	return result;
}

/**
 * Read a device's location from {@link parseRawCommentFacts}-shaped output
 * (every `k=v` comment token, unfiltered — see `src/resolver/comment-kv.ts`).
 * Lenient by design: a missing or malformed `lat`/`lon` (e.g. a hand-edited
 * comment) yields `undefined` rather than throwing — this is a read path, and
 * write-time validation (`validateCommentKvUpdates` in `src/devices.ts`) is
 * what keeps stored values well-formed. `altitudeType` defaults to `MSL` when
 * `altitude` is present but no recognized `altitude-type` fact is stored.
 */
export function deviceLocation(
	facts: Record<string, string>,
): DeviceLocation | undefined {
	const rawLat = facts["lat"];
	const rawLon = facts["lon"];
	if (rawLat === undefined || rawLon === undefined) {
		return undefined;
	}
	const lat = toFiniteNumber(rawLat);
	const lon = toFiniteNumber(rawLon);
	if (
		lat === undefined ||
		lon === undefined ||
		lat < COORDINATE_RANGE.lat.min ||
		lat > COORDINATE_RANGE.lat.max ||
		lon < COORDINATE_RANGE.lon.min ||
		lon > COORDINATE_RANGE.lon.max
	) {
		return undefined;
	}
	const location: DeviceLocation = { lat, lon };
	const rawAltitude = facts["altitude"];
	if (rawAltitude !== undefined) {
		const altitude = toFiniteNumber(rawAltitude);
		if (altitude !== undefined) {
			location.altitude = altitude;
			const rawType = facts["altitude-type"];
			const upper = rawType?.trim().toUpperCase();
			location.altitudeType =
				upper === "MSL" || upper === "AGL" ? upper : "MSL";
		}
	}
	return location;
}
