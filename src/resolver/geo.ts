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
 *     `long` -> `lon`, `latitude` -> `lat`, `alt`/`ele`/`elevation` ->
 *     `altitude`, and mixed-case `altitude-type`) so the canonical key is what
 *     lands in the comment and the envelope,
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
 * Slice 2 (`--near`/`--bbox`, haversine/bbox query predicates) lives at the
 * bottom of this file; it is pure geo math over parsed {@link DeviceLocation}s,
 * with the CDB-entry composition in `src/resolver/facts.ts`.
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
 * Alias -> canonical key map for the geo comment-kv fields. Applied in ONE
 * place — {@link canonicalizeGeoKey} — so both `--flag` lowering and bare `k=v`
 * positionals agree on the canonical key that lands in storage. `altitude` stays
 * the canonical field (the ISO 6709 / EPSG / IETF `geo:` / W3C-Geolocation term);
 * `elevation`/`ele` are GPX-muscle-memory aliases only, never a rename. Every
 * canonical key also maps to itself so a mixed-case bare token (`LAT=`,
 * `ALTITUDE-TYPE=`) canonicalizes by case too.
 */
const GEO_KEY_ALIASES: Readonly<
	Record<string, "lat" | "lon" | "altitude" | "altitude-type">
> = {
	lat: "lat",
	latitude: "lat",
	lon: "lon",
	lng: "lon",
	longitude: "lon",
	long: "lon",
	altitude: "altitude",
	alt: "altitude",
	ele: "altitude",
	elevation: "altitude",
	"altitude-type": "altitude-type",
	"alt-type": "altitude-type",
};

/**
 * Canonicalize a comment-kv key alias (case-insensitive) to its stored form.
 * A key with no known alias is returned unchanged (original casing preserved),
 * so this is safe to apply to every bare `k=v` token, not just geo ones.
 */
export function canonicalizeGeoKey(key: string): string {
	return GEO_KEY_ALIASES[key.toLowerCase()] ?? key;
}

/**
 * Parse a **strict decimal** number string: an optional leading `-`, one or more
 * digits, and an optional dotted fraction — the decimal-degrees / meters grammar
 * the GPS fields document (`docs/CONSTITUTION.md`). Returns `undefined` for blank
 * input and for forms a bare `Number()` would silently accept but the spec does
 * not: hex (`0x10`), scientific (`1e2`), or a leading `+`. Also rejects a value
 * that overflows to `±Infinity` (e.g. a 400-digit integer) — `parseAltitude` has
 * no range clamp, so the finite guard is what keeps `Infinity` out of it.
 */
function parseDecimal(value: string): number | undefined {
	const trimmed = value.trim();
	if (!/^-?[0-9]+(?:\.[0-9]+)?$/.test(trimmed)) {
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
	const parsed = parseDecimal(value);
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
	const parsed = parseDecimal(value);
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
	const lat = parseDecimal(rawLat);
	const lon = parseDecimal(rawLon);
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
		const altitude = parseDecimal(rawAltitude);
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

// --- Slice 2: geo query predicates (`--near` / `--bbox`) ---------------------
//
// Pure geo math + predicate parsing. These operate on already-parsed
// {@link DeviceLocation}s (altitude is ignored — the query is 2-D lat/lon). The
// CDB-entry composition (read a record's location, union/AND into a selection)
// lives in `src/resolver/facts.ts` and the callers; this file stays free of any
// CDB/record awareness.

/** A `--near <lat>,<lon>,<radius>` predicate, radius already resolved to meters. */
export interface NearPredicate {
	lat: number;
	lon: number;
	radiusMeters: number;
}

/** A `--bbox <south>,<west>,<north>,<east>` predicate (lat-first, decimal degrees). */
export interface BboxPredicate {
	south: number;
	west: number;
	north: number;
	east: number;
}

/**
 * Radius unit suffixes (Redis GEOSEARCH vocabulary), case-insensitive. A bare
 * number with no suffix defaults to **km** (the common operator/agent unit for
 * "devices within N of here").
 */
const RADIUS_UNIT_METERS: Readonly<Record<string, number>> = {
	m: 1,
	km: 1000,
	mi: 1609.344,
	ft: 0.3048,
};

/**
 * Parse a radius like `50km` / `500m` / `10mi` / `2000ft` (or a bare number,
 * defaulting to km) to meters. Throws `input/invalid-radius` on a malformed
 * value, an unknown unit, or a negative magnitude.
 */
export function parseRadius(value: string): number {
	// Unambiguous number grammar (integer part then an optional dotted fraction),
	// so there are no adjacent same-class quantifiers to backtrack over — avoids
	// the polynomial-ReDoS a `[0-9]*\.?[0-9]+` shape would allow on long digit runs.
	const match = /^(-?[0-9]+(?:\.[0-9]+)?)\s*([a-z]+)?$/i.exec(value.trim());
	const unitKey = match?.[2]?.toLowerCase() ?? "km";
	const perUnit = RADIUS_UNIT_METERS[unitKey];
	const magnitude = match ? Number(match[1]) : Number.NaN;
	if (!match || perUnit === undefined || !Number.isFinite(magnitude)) {
		throw new CentrsError({
			code: "input/invalid-radius",
			summary: `Invalid radius "${value}"; expected a number with an optional m/km/mi/ft suffix.`,
			remediation:
				"Pass a positive radius like `50km`, `500m`, `10mi`, or `2000ft` (a bare number is kilometers).",
			context: { value },
		});
	}
	const meters = magnitude * perUnit;
	if (meters < 0) {
		throw new CentrsError({
			code: "input/invalid-radius",
			summary: `Invalid radius "${value}"; must not be negative.`,
			remediation: "Pass a positive radius, e.g. `50km`.",
			context: { value },
		});
	}
	return meters;
}

/** IUGG mean Earth radius (meters) — the standard sphere for haversine. */
const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in meters between two lat/lon points (haversine on a
 * sphere of {@link EARTH_RADIUS_METERS}). Accurate to well under 1% for the
 * fleet-proximity distances centrs cares about; not a geodesic on the ellipsoid.
 */
export function haversineMeters(
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
): number {
	const dLat = toRadians(b.lat - a.lat);
	const dLon = toRadians(b.lon - a.lon);
	const lat1 = toRadians(a.lat);
	const lat2 = toRadians(b.lat);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Parse `--near <lat>,<lon>,<radius>` (lat-first — see module doc-comment).
 * Requires exactly three non-empty comma parts (`input/invalid-command` on wrong
 * arity); the radius is resolved to meters ({@link parseRadius}).
 */
export function parseNear(value: string): NearPredicate {
	const parts = value.split(",").map((part) => part.trim());
	if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
		throw new CentrsError({
			code: "input/invalid-command",
			summary: `--near "${value}" must be <lat>,<lon>,<radius>.`,
			remediation:
				"Pass a center and radius, e.g. --near 37.7749,-122.4194,50km (lat,lon first, radius last).",
			context: { near: value },
		});
	}
	const [rawLat, rawLon, rawRadius] = parts as [string, string, string];
	return {
		lat: parseLatLon(rawLat, "lat"),
		lon: parseLatLon(rawLon, "lon"),
		radiusMeters: parseRadius(rawRadius),
	};
}

/** True when `loc` is within `near`'s radius (great-circle). Altitude ignored. */
export function matchesNear(loc: DeviceLocation, near: NearPredicate): boolean {
	return haversineMeters(loc, near) <= near.radiusMeters;
}

/**
 * Parse `--bbox <south>,<west>,<north>,<east>` (= minLat,minLon,maxLat,maxLon,
 * lat-first). Requires four non-empty parts and `south <= north`,
 * `west <= east` (no antimeridian wrap in v1) — else `input/invalid-bbox`.
 */
export function parseBbox(value: string): BboxPredicate {
	const parts = value.split(",").map((part) => part.trim());
	if (parts.length !== 4 || parts.some((part) => part.length === 0)) {
		throw new CentrsError({
			code: "input/invalid-bbox",
			summary: `--bbox "${value}" must be <south>,<west>,<north>,<east>.`,
			remediation:
				"Pass a lat-first box, e.g. --bbox 37.70,-122.52,37.83,-122.35 (south,west,north,east).",
			context: { bbox: value },
		});
	}
	const [rawSouth, rawWest, rawNorth, rawEast] = parts as [
		string,
		string,
		string,
		string,
	];
	const box: BboxPredicate = {
		south: parseLatLon(rawSouth, "lat"),
		west: parseLatLon(rawWest, "lon"),
		north: parseLatLon(rawNorth, "lat"),
		east: parseLatLon(rawEast, "lon"),
	};
	if (box.south > box.north || box.west > box.east) {
		throw new CentrsError({
			code: "input/invalid-bbox",
			summary: `--bbox "${value}" must have south <= north and west <= east.`,
			remediation:
				"Order corners south,west,north,east; an antimeridian-crossing box is not supported.",
			context: { bbox: value },
		});
	}
	return box;
}

/** True when `loc` falls inside the axis-aligned `box` (inclusive edges). */
export function matchesBbox(loc: DeviceLocation, box: BboxPredicate): boolean {
	return (
		loc.lat >= box.south &&
		loc.lat <= box.north &&
		loc.lon >= box.west &&
		loc.lon <= box.east
	);
}
