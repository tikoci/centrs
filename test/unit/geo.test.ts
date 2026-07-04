import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	canonicalizeGeoKey,
	deviceLocation,
	haversineMeters,
	matchesBbox,
	matchesNear,
	parseAltitude,
	parseAltitudeType,
	parseBbox,
	parseGpsTuple,
	parseLatLon,
	parseNear,
	parseRadius,
} from "../../src/resolver/geo.ts";

/** Assert `fn` throws a CentrsError with the given code. */
function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
		throw new Error(`expected a throw with code ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(CentrsError);
		expect((error as CentrsError).code as string).toBe(code);
	}
}

describe("parseLatLon", () => {
	test("accepts a valid latitude", () => {
		expect(parseLatLon("37.7749", "lat")).toBe(37.7749);
	});

	test("accepts a valid longitude, including negatives", () => {
		expect(parseLatLon("-122.4194", "lon")).toBe(-122.4194);
	});

	test("accepts the range boundaries", () => {
		expect(parseLatLon("-90", "lat")).toBe(-90);
		expect(parseLatLon("90", "lat")).toBe(90);
		expect(parseLatLon("-180", "lon")).toBe(-180);
		expect(parseLatLon("180", "lon")).toBe(180);
	});

	test("rejects an out-of-range latitude with input/invalid-coordinate", () => {
		expect(() => parseLatLon("91", "lat")).toThrow(CentrsError);
		try {
			parseLatLon("91", "lat");
			throw new Error("expected parseLatLon to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(CentrsError);
			expect((error as CentrsError).code).toBe("input/invalid-coordinate");
		}
	});

	test("rejects an out-of-range longitude with input/invalid-coordinate", () => {
		try {
			parseLatLon("181", "lon");
			throw new Error("expected parseLatLon to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("input/invalid-coordinate");
		}
	});

	test("rejects non-numeric input", () => {
		expect(() => parseLatLon("abc", "lat")).toThrow(CentrsError);
	});

	test("rejects hex and scientific notation (strict decimal degrees only)", () => {
		// Number("0x10")===16 and Number("1e2")===100 would silently pass a bare
		// Number() parse; decimal degrees must reject both.
		expectCode(() => parseLatLon("0x10", "lat"), "input/invalid-coordinate");
		expectCode(() => parseLatLon("1e2", "lon"), "input/invalid-coordinate");
		expectCode(() => parseLatLon("+45", "lat"), "input/invalid-coordinate");
	});

	test("rejects an empty string rather than treating it as 0", () => {
		// Number("") === 0 in JS; the parser must not silently accept a cleared
		// value as a valid coordinate.
		expect(() => parseLatLon("", "lat")).toThrow(CentrsError);
		expect(() => parseLatLon("   ", "lon")).toThrow(CentrsError);
	});

	test("lat-first invariant: a swapped San Francisco coordinate fails range", () => {
		// SF is roughly lat=37.7749, lon=-122.4194. Swapped into lat position,
		// -122.4194 is outside [-90, 90] and must be rejected, not silently
		// accepted as a (wrong) latitude.
		expect(() => parseLatLon("-122.4194", "lat")).toThrow(CentrsError);
		try {
			parseLatLon("-122.4194", "lat");
			throw new Error("expected parseLatLon to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("input/invalid-coordinate");
		}
	});
});

describe("parseAltitude", () => {
	test("accepts a positive altitude", () => {
		expect(parseAltitude("120")).toBe(120);
	});

	test("accepts a negative altitude (below sea level)", () => {
		expect(parseAltitude("-25.5")).toBe(-25.5);
	});

	test("accepts zero", () => {
		expect(parseAltitude("0")).toBe(0);
	});

	test("rejects non-numeric input with input/invalid-altitude", () => {
		try {
			parseAltitude("abc");
			throw new Error("expected parseAltitude to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("input/invalid-altitude");
		}
	});

	test("rejects an empty string rather than treating it as 0", () => {
		expect(() => parseAltitude("")).toThrow(CentrsError);
	});

	test("rejects hex and scientific notation (strict decimal meters only)", () => {
		expectCode(() => parseAltitude("0x10"), "input/invalid-altitude");
		expectCode(() => parseAltitude("1e2"), "input/invalid-altitude");
	});
});

describe("parseAltitudeType", () => {
	test("accepts MSL and AGL", () => {
		expect(parseAltitudeType("MSL")).toBe("MSL");
		expect(parseAltitudeType("AGL")).toBe("AGL");
	});

	test("is case-insensitive and normalizes to upper case", () => {
		expect(parseAltitudeType("msl")).toBe("MSL");
		expect(parseAltitudeType("Agl")).toBe("AGL");
		expect(parseAltitudeType(" msl ")).toBe("MSL");
	});

	test("rejects an unknown value with input/invalid-altitude", () => {
		try {
			parseAltitudeType("wgs84");
			throw new Error("expected parseAltitudeType to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("input/invalid-altitude");
		}
	});
});

describe("canonicalizeGeoKey", () => {
	test("canonicalizes lon aliases", () => {
		expect(canonicalizeGeoKey("lng")).toBe("lon");
		expect(canonicalizeGeoKey("longitude")).toBe("lon");
		expect(canonicalizeGeoKey("long")).toBe("lon");
		expect(canonicalizeGeoKey("lon")).toBe("lon");
	});

	test("canonicalizes lat aliases", () => {
		expect(canonicalizeGeoKey("latitude")).toBe("lat");
		expect(canonicalizeGeoKey("lat")).toBe("lat");
	});

	test("canonicalizes altitude aliases (incl. ele/elevation GPX muscle memory)", () => {
		expect(canonicalizeGeoKey("alt")).toBe("altitude");
		expect(canonicalizeGeoKey("ele")).toBe("altitude");
		expect(canonicalizeGeoKey("elevation")).toBe("altitude");
		expect(canonicalizeGeoKey("altitude")).toBe("altitude");
	});

	test("is case-insensitive", () => {
		expect(canonicalizeGeoKey("LNG")).toBe("lon");
		expect(canonicalizeGeoKey("Latitude")).toBe("lat");
	});

	test("altitude-type canonicalizes by case and via --alt-type spelling", () => {
		expect(canonicalizeGeoKey("altitude-type")).toBe("altitude-type");
		// A bare mixed-case token must land on the canonical key, not pass through.
		expect(canonicalizeGeoKey("ALTITUDE-TYPE")).toBe("altitude-type");
		expect(canonicalizeGeoKey("alt-type")).toBe("altitude-type");
	});

	test("a non-geo key passes through unchanged, original casing preserved", () => {
		expect(canonicalizeGeoKey("via")).toBe("via");
		expect(canonicalizeGeoKey("Board")).toBe("Board");
	});
});

describe("parseGpsTuple", () => {
	test("parses the minimum lat,lon form", () => {
		const parsed = parseGpsTuple("37.7749,-122.4194");
		expect(parsed.lat).toBe(37.7749);
		expect(parsed.lon).toBe(-122.4194);
		expect(parsed.altitude).toBeUndefined();
		expect(parsed.altitudeType).toBeUndefined();
		expect(parsed.raw).toEqual({ lat: "37.7749", lon: "-122.4194" });
	});

	test("trims whitespace around each component", () => {
		const parsed = parseGpsTuple(" 37.7749 , -122.4194 ");
		expect(parsed.raw).toEqual({ lat: "37.7749", lon: "-122.4194" });
	});

	test("the 3-part form defaults altitude-type to MSL", () => {
		const parsed = parseGpsTuple("37.7749,-122.4194,16");
		expect(parsed.altitude).toBe(16);
		expect(parsed.altitudeType).toBe("MSL");
		expect(parsed.raw.altitude).toBe("16");
		expect(parsed.raw.altitudeType).toBe("MSL");
	});

	test("the 4-part form carries an explicit altitude-type, normalized", () => {
		const parsed = parseGpsTuple("37.7749,-122.4194,16,agl");
		expect(parsed.altitudeType).toBe("AGL");
		expect(parsed.raw.altitudeType).toBe("AGL");
	});

	test("rejects a single-part value with input/incomplete-gps", () => {
		try {
			parseGpsTuple("37.7749");
			throw new Error("expected parseGpsTuple to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("input/incomplete-gps");
		}
	});

	test("rejects a 5-part value with input/incomplete-gps", () => {
		try {
			parseGpsTuple("37.7749,-122.4194,16,MSL,extra");
			throw new Error("expected parseGpsTuple to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("input/incomplete-gps");
		}
	});

	test("rejects an empty component (e.g. a trailing comma) with input/incomplete-gps", () => {
		try {
			parseGpsTuple("37.7749,-122.4194,");
			throw new Error("expected parseGpsTuple to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("input/incomplete-gps");
		}
	});

	test("rejects an out-of-range component with input/invalid-coordinate", () => {
		try {
			parseGpsTuple("999,-122.4194");
			throw new Error("expected parseGpsTuple to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("input/invalid-coordinate");
		}
	});

	test("lat-first invariant: a lon,lat-swapped SF coordinate fails range", () => {
		// Correct is lat,lon = 37.7749,-122.4194. Swapped (lon,lat) puts
		// -122.4194 in the lat slot, which is out of [-90, 90].
		try {
			parseGpsTuple("-122.4194,37.7749");
			throw new Error("expected parseGpsTuple to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("input/invalid-coordinate");
		}
	});
});

describe("deviceLocation", () => {
	test("returns undefined when lat/lon are absent", () => {
		expect(deviceLocation({})).toBeUndefined();
		expect(deviceLocation({ board: "RB5009" })).toBeUndefined();
	});

	test("returns undefined when only one of lat/lon is present", () => {
		expect(deviceLocation({ lat: "37.7749" })).toBeUndefined();
		expect(deviceLocation({ lon: "-122.4194" })).toBeUndefined();
	});

	test("reads a well-formed lat/lon pair", () => {
		expect(deviceLocation({ lat: "37.7749", lon: "-122.4194" })).toEqual({
			lat: 37.7749,
			lon: -122.4194,
		});
	});

	test("reads altitude with an explicit altitude-type", () => {
		expect(
			deviceLocation({
				lat: "37.7749",
				lon: "-122.4194",
				altitude: "16",
				"altitude-type": "agl",
			}),
		).toEqual({
			lat: 37.7749,
			lon: -122.4194,
			altitude: 16,
			altitudeType: "AGL",
		});
	});

	test("defaults altitude-type to MSL when altitude is present but the type fact is missing", () => {
		expect(
			deviceLocation({ lat: "37.7749", lon: "-122.4194", altitude: "16" }),
		).toEqual({
			lat: 37.7749,
			lon: -122.4194,
			altitude: 16,
			altitudeType: "MSL",
		});
	});

	test("is lenient on a malformed/out-of-range lat or lon (read path, not a throw)", () => {
		expect(
			deviceLocation({ lat: "not-a-number", lon: "-122.4194" }),
		).toBeUndefined();
		expect(deviceLocation({ lat: "999", lon: "-122.4194" })).toBeUndefined();
	});

	test("lat-first invariant: a swapped pair either fails range (undefined) or is simply the wrong point — never silently 'corrected'", () => {
		// A swapped SF pair (lon in the lat slot) is out of latitude range.
		expect(
			deviceLocation({ lat: "-122.4194", lon: "37.7749" }),
		).toBeUndefined();
	});
});

// --- Slice 2: query predicates ----------------------------------------------

describe("parseRadius", () => {
	test("resolves each unit suffix to meters (case-insensitive)", () => {
		expect(parseRadius("500m")).toBe(500);
		expect(parseRadius("2KM")).toBe(2000);
		expect(parseRadius("1mi")).toBeCloseTo(1609.344, 3);
		expect(parseRadius("100ft")).toBeCloseTo(30.48, 6);
	});

	test("a bare number defaults to kilometers", () => {
		expect(parseRadius("50")).toBe(50_000);
		expect(parseRadius(" 1.5 ")).toBe(1500);
	});

	test("rejects an unknown unit / malformed value / negative with input/invalid-radius", () => {
		expectCode(() => parseRadius("50furlongs"), "input/invalid-radius");
		expectCode(() => parseRadius("km"), "input/invalid-radius");
		expectCode(() => parseRadius(""), "input/invalid-radius");
		expectCode(() => parseRadius("-5km"), "input/invalid-radius");
	});
});

describe("haversineMeters", () => {
	test("SFO -> OAK is ~17.2 km (known great-circle distance)", () => {
		const sfo = { lat: 37.6213, lon: -122.379 };
		const oak = { lat: 37.7126, lon: -122.2197 };
		const meters = haversineMeters(sfo, oak);
		// Reference distance ~17.2 km; allow a small tolerance for the sphere model.
		expect(meters).toBeGreaterThan(16_500);
		expect(meters).toBeLessThan(18_000);
	});

	test("distance to self is zero", () => {
		expect(haversineMeters({ lat: 10, lon: 20 }, { lat: 10, lon: 20 })).toBe(0);
	});
});

describe("parseNear", () => {
	test("parses lat-first <lat>,<lon>,<radius> into a predicate in meters", () => {
		expect(parseNear("37.7749,-122.4194,50km")).toEqual({
			lat: 37.7749,
			lon: -122.4194,
			radiusMeters: 50_000,
		});
	});

	test("wrong arity is input/invalid-command; bad radius is input/invalid-radius; bad coord is input/invalid-coordinate", () => {
		expectCode(() => parseNear("37.77,-122.41"), "input/invalid-command");
		expectCode(() => parseNear("37.77,-122.41,5,6"), "input/invalid-command");
		expectCode(() => parseNear("37.77,-122.41,nope"), "input/invalid-radius");
		expectCode(() => parseNear("100,-122.41,5km"), "input/invalid-coordinate");
	});
});

describe("matchesNear", () => {
	const near = parseNear("37.7749,-122.4194,10km");

	test("a point inside the radius matches; one outside does not", () => {
		// ~2 km away (downtown SF) is inside a 10 km radius.
		expect(matchesNear({ lat: 37.7899, lon: -122.4094 }, near)).toBe(true);
		// Oakland (~13 km) is outside a 10 km radius.
		expect(matchesNear({ lat: 37.8044, lon: -122.2712 }, near)).toBe(false);
	});
});

describe("parseBbox", () => {
	test("parses lat-first south,west,north,east", () => {
		expect(parseBbox("37.70,-122.52,37.83,-122.35")).toEqual({
			south: 37.7,
			west: -122.52,
			north: 37.83,
			east: -122.35,
		});
	});

	test("wrong arity and min>max are input/invalid-bbox; out-of-range corner is input/invalid-coordinate", () => {
		expectCode(() => parseBbox("37.70,-122.52,37.83"), "input/invalid-bbox");
		// south > north (corners swapped) is rejected — no antimeridian/inverted box.
		expectCode(
			() => parseBbox("37.83,-122.52,37.70,-122.35"),
			"input/invalid-bbox",
		);
		// west > east.
		expectCode(
			() => parseBbox("37.70,-122.35,37.83,-122.52"),
			"input/invalid-bbox",
		);
		expectCode(
			() => parseBbox("37.70,-200,37.83,-122.35"),
			"input/invalid-coordinate",
		);
	});
});

describe("matchesBbox", () => {
	const box = parseBbox("37.70,-122.52,37.83,-122.35");

	test("inside matches (inclusive edges); outside does not", () => {
		expect(matchesBbox({ lat: 37.7749, lon: -122.4194 }, box)).toBe(true);
		// On the south/west corner (inclusive).
		expect(matchesBbox({ lat: 37.7, lon: -122.52 }, box)).toBe(true);
		// North of the box.
		expect(matchesBbox({ lat: 37.9, lon: -122.4 }, box)).toBe(false);
		// East of the box.
		expect(matchesBbox({ lat: 37.75, lon: -122.1 }, box)).toBe(false);
	});
});
