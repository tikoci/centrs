import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	canonicalizeGeoKey,
	deviceLocation,
	parseAltitude,
	parseAltitudeType,
	parseGpsTuple,
	parseLatLon,
} from "../../src/resolver/geo.ts";

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

	test("canonicalizes altitude aliases", () => {
		expect(canonicalizeGeoKey("alt")).toBe("altitude");
		expect(canonicalizeGeoKey("elevation")).toBe("altitude");
		expect(canonicalizeGeoKey("altitude")).toBe("altitude");
	});

	test("is case-insensitive", () => {
		expect(canonicalizeGeoKey("LNG")).toBe("lon");
		expect(canonicalizeGeoKey("Latitude")).toBe("lat");
	});

	test("altitude-type has no alias and passes through unchanged", () => {
		expect(canonicalizeGeoKey("altitude-type")).toBe("altitude-type");
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
