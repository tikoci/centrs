import { describe, expect, test } from "bun:test";
import { winBoxCdbRecordType } from "../../src/data/winbox-cdb.ts";
import {
	type DeviceRecord,
	deviceRecordSchema,
	isKnownRecordType,
	parseDeviceRecord,
	recordTypeNames,
} from "../../src/devices-schema.ts";
import { CentrsError } from "../../src/errors.ts";

describe("deviceRecordSchema / parseDeviceRecord", () => {
	const valid: DeviceRecord = {
		recordType: winBoxCdbRecordType.ipAdmin,
		target: "192.0.2.5:8728",
		user: "admin",
		password: "secret",
		comment: "office uplink",
		group: "edge",
		profile: "<none>",
		savedPassword: true,
	};

	test("accepts a well-formed record and returns the typed value", () => {
		expect(parseDeviceRecord(valid)).toEqual(valid);
	});

	test("accepts a minimal record (only recordType + target)", () => {
		const minimal = {
			recordType: winBoxCdbRecordType.macTarget,
			target: "0:1:2:3:4:5",
		};
		expect(parseDeviceRecord(minimal)).toEqual(minimal);
	});

	test("a blank or whitespace-only target throws a typed, actionable error", () => {
		for (const target of ["", "   "]) {
			try {
				parseDeviceRecord({ recordType: winBoxCdbRecordType.ipAdmin, target });
				throw new Error("expected parseDeviceRecord to throw");
			} catch (error) {
				expect(error).toBeInstanceOf(CentrsError);
				expect((error as CentrsError).code).toBe("cdb/invalid-record");
				expect((error as CentrsError).context).toMatchObject({
					field: "target",
				});
				expect((error as CentrsError).remediation).toContain("target");
			}
		}
	});

	test("rejects a wrong field type (user must be a string)", () => {
		try {
			parseDeviceRecord({
				recordType: winBoxCdbRecordType.ipAdmin,
				target: "192.0.2.5",
				user: 5,
			});
			throw new Error("expected parseDeviceRecord to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("cdb/invalid-record");
			expect((error as CentrsError).context).toMatchObject({ field: "user" });
		}
	});

	test("a non-object input blames the whole record and carries Zod cause data", () => {
		try {
			parseDeviceRecord("not-a-record");
			throw new Error("expected parseDeviceRecord to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("cdb/invalid-record");
			expect((error as CentrsError).context).toMatchObject({
				field: "(record)",
			});
			expect((error as CentrsError).remediation).toContain("recordType");
			// Flattened Zod issues are attached for debugging.
			const causeData = (error as CentrsError).causeData;
			expect(Array.isArray(causeData)).toBe(true);
			expect(causeData).toHaveLength(expect.any(Number));
			expect((causeData as unknown[]).length).toBeGreaterThan(0);

			const firstIssue = (causeData as Array<Record<string, unknown>>)[0];
			expect(firstIssue).toMatchObject({
				code: expect.any(String),
				message: expect.any(String),
				path: expect.any(Array),
			});
			expect(String(firstIssue.message)).toMatch(/object/i);
		}
	});

	test("rejects a non-integer / negative recordType", () => {
		for (const recordType of [1.5, -1]) {
			expect(() =>
				parseDeviceRecord({ recordType, target: "192.0.2.5" }),
			).toThrow(CentrsError);
		}
	});

	test("is LENIENT on an unknown recordType so decoded records round-trip", () => {
		// The CDB decoder preserves record types centrs does not name yet; the
		// canonical model must accept them or `set` would regress on such a record.
		const unknown = parseDeviceRecord({ recordType: 99, target: "192.0.2.5" });
		expect(unknown.recordType).toBe(99);
		expect(isKnownRecordType(99)).toBe(false);

		// Boundary: largest safe integer should still be accepted when non-negative.
		const maxSafe = parseDeviceRecord({
			recordType: Number.MAX_SAFE_INTEGER,
			target: "192.0.2.5",
		});
		expect(maxSafe.recordType).toBe(Number.MAX_SAFE_INTEGER);
		expect(isKnownRecordType(Number.MAX_SAFE_INTEGER)).toBe(false);

		// Just beyond the safe integer boundary should be rejected.
		expect(() =>
			parseDeviceRecord({
				recordType: Number.MAX_SAFE_INTEGER + 1,
				target: "192.0.2.5",
			}),
		).toThrow(CentrsError);
	});

	test("isKnownRecordType matches the named WinBox types only", () => {
		expect(isKnownRecordType(winBoxCdbRecordType.ipAdmin)).toBe(true);
		expect(isKnownRecordType(winBoxCdbRecordType.macTarget)).toBe(true);
		expect(isKnownRecordType(0)).toBe(false);
	});

	test("recordTypeNames lists the named types for the strict CLI check", () => {
		expect(recordTypeNames).toContain("ipAdmin");
		expect(recordTypeNames).toContain("macTarget");
		expect([...recordTypeNames].sort()).toEqual(
			Object.keys(winBoxCdbRecordType).sort(),
		);
	});

	test("schema is the typed source of truth (safeParse surfaces issues)", () => {
		const parsed = deviceRecordSchema.safeParse({ target: "x" });
		expect(parsed.success).toBe(false);
	});
});
