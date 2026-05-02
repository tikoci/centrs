import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	analyzeEncryptedWinBoxCdb,
	buildWinBoxCdbEntryRecord,
	decodeWinBoxCdbEntries,
	encodeOpenWinBoxCdb,
	parseWinBoxCdb,
	WINBOX_CDB_SAVED_PASSWORD_FLAG,
	type WinBoxCdbRecord,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";

// cspell:ignore nosaved owne mygroup mycomment nopassword

const fixtureRoot = new URL("../fixtures/winbox-cdb/", import.meta.url);

describe("WinBox CDB", () => {
	test("parses the minimal open file", () => {
		const file = parseFixture("min.cdb");
		if (file.mode !== "open") {
			throw new Error("Expected min.cdb to parse as an open WinBox CDB.");
		}
		expect(file.records).toHaveLength(0);
	});

	test("detects encrypted files without pretending to decode them", () => {
		const file = parseFixture("encrypted-min-with-one-normal-one-romon.cdb");
		expect(file.mode).toBe("encrypted");
	});

	test("summarizes encrypted payload alignment clues without pretending to decrypt", () => {
		const file = parseFixture("encrypted-min-with-one-normal-one-romon.cdb");
		if (file.mode !== "encrypted") {
			throw new Error("Expected encrypted fixture to parse as encrypted.");
		}
		const analysis = analyzeEncryptedWinBoxCdb(file, {
			maxCandidateHeaderLength: 32,
		});
		expect(analysis.payloadLength).toBe(321);
		expect(analysis.firstPayloadByte).toBe(0x83);
		expect(analysis.lastPayloadByte).toBe(0x72);
		expect(analysis.firstPayloadBytesHex).toBe(
			"83 44 56 52 03 82 51 98 1d 1e 8c 51 19 4c 3f c8",
		);
		expect(analysis.lastPayloadBytesHex).toBe(
			"ca 6f a2 39 56 3e a9 10 c9 53 a6 c9 b6 d1 1c 72",
		);
		expect(analysis.alignmentCandidates).toContainEqual({
			blockSize: 16,
			payloadRemainder: 1,
			candidateHeaderLengths: [1, 17],
		});
	});

	test("decodes representative entry fields from the synthetic fixtures", () => {
		const file = parseFixture(
			"user-with-saved-123-password-profile-own-with-group-mygroup-with-comment-mycomment.cdb",
		);
		if (file.mode !== "open") {
			throw new Error("Expected representative fixture to parse as open.");
		}
		const [entry] = decodeWinBoxCdbEntries(file);
		if (!entry) {
			throw new Error("Expected representative fixture to contain one entry.");
		}
		expect(entry.recordType).toBe(winBoxCdbRecordType.ipUser);
		expect(entry.target).toBe("192.0.2.1");
		expect(entry.user).toBe("user");
		expect(entry.password).toBe("123");
		expect(entry.session).toBe("");
		expect(entry.group).toBe("mygroup");
		expect(entry.comment).toBe("mycomment");
		expect(entry.commentMirror).toBe("mycomment");
		expect(entry.profile).toBe("<own>");
		expect(entry.savedPassword).toBe(true);
	});

	test("round-trips every open fixture byte-for-byte", () => {
		for (const name of openFixtureNames) {
			const bytes = readFixture(name);
			const file = parseWinBoxCdb(bytes);
			if (file.mode !== "open") {
				throw new Error(`Expected ${name} to parse as an open WinBox CDB.`);
			}
			expect(encodeOpenWinBoxCdb(file.records)).toEqual(bytes);
		}
	});

	test("builds a new open CDB record and preserves its modeled fields", () => {
		const record = buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipUser,
			target: "198.51.100.10",
			user: "writer",
			password: "secret",
			comment: "generated",
			group: "lab",
			profile: "<own>",
			savedPassword: true,
		});

		const bytes = encodeOpenWinBoxCdb([record]);
		const file = parseWinBoxCdb(bytes);
		if (file.mode !== "open") {
			throw new Error("Expected generated file to parse as open.");
		}
		const [entry] = decodeWinBoxCdbEntries(file);
		if (!entry) {
			throw new Error("Expected generated file to contain one entry.");
		}
		expect(entry.recordType).toBe(winBoxCdbRecordType.ipUser);
		expect(entry.target).toBe("198.51.100.10");
		expect(entry.user).toBe("writer");
		expect(entry.password).toBe("secret");
		expect(entry.session).toBe("");
		expect(entry.comment).toBe("generated");
		expect(entry.commentMirror).toBe("generated");
		expect(entry.group).toBe("lab");
		expect(entry.profile).toBe("<own>");
		expect(entry.flags).toBe(WINBOX_CDB_SAVED_PASSWORD_FLAG);
	});

	test("keeps known extra fields like session and preserves unknown string fields", () => {
		const record = buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipUser,
			target: "203.0.113.50",
			user: "extra",
			session: "session-01",
			comment: "with extras",
			group: "extras",
			profile: "<own>",
			extraFields: [{ tag: 15, marker: 0x00, tcode: 0x21, value: "custom" }],
		});

		const bytes = encodeOpenWinBoxCdb([record]);
		const file = parseWinBoxCdb(bytes);
		if (file.mode !== "open") {
			throw new Error("Expected extra-field file to parse as open.");
		}
		const [entry] = decodeWinBoxCdbEntries(file);
		if (!entry) {
			throw new Error("Expected extra-field file to contain one entry.");
		}
		expect(entry.session).toBe("session-01");
		expect(findField(file.records[0], 15)?.value).toBe("custom");
		expect(encodeOpenWinBoxCdb(file.records)).toEqual(bytes);
	});

	test("supports both short and long string encodings", () => {
		const comment255 = "x".repeat(255);
		const shortRecord = buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipUser,
			target: "203.0.113.60",
			user: "long",
			comment: comment255,
			profile: "<own>",
		});

		const shortBytes = encodeOpenWinBoxCdb([shortRecord]);
		const shortFile = parseWinBoxCdb(shortBytes);
		if (shortFile.mode !== "open") {
			throw new Error("Expected long-string file to parse as open.");
		}
		const [shortEntry] = decodeWinBoxCdbEntries(shortFile);
		if (!shortEntry) {
			throw new Error("Expected long-string file to contain one entry.");
		}
		expect(shortEntry.comment).toBe(comment255);
		expect(findField(shortFile.records[0], 4)?.tcode).toBe(0x21);
		expect(findField(shortFile.records[0], 9)?.tcode).toBe(0x21);

		const comment600 = "y".repeat(600);
		const longRecord = buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipUser,
			target: "203.0.113.61",
			user: "longer",
			comment: comment600,
			profile: "<own>",
		});

		const longBytes = encodeOpenWinBoxCdb([longRecord]);
		const longFile = parseWinBoxCdb(longBytes);
		if (longFile.mode !== "open") {
			throw new Error("Expected long-string file to parse as open.");
		}
		const [longEntry] = decodeWinBoxCdbEntries(longFile);
		if (!longEntry) {
			throw new Error("Expected long-string file to contain one entry.");
		}
		expect(longEntry.comment).toBe(comment600);
		expect(findField(longFile.records[0], 4)?.tcode).toBe(0x20);
		expect(findField(longFile.records[0], 9)?.tcode).toBe(0x20);
		expect(encodeOpenWinBoxCdb(longFile.records)).toEqual(longBytes);

		expect(() =>
			encodeOpenWinBoxCdb([
				buildWinBoxCdbEntryRecord({
					recordType: winBoxCdbRecordType.ipAdmin,
					target: "203.0.113.62",
					user: "too-long",
					comment: "z".repeat(65536),
				}),
			]),
		).toThrow("exceeds 65535 bytes");
	});

	test("rejects encrypted analysis on open CDB input", () => {
		expect(() => analyzeEncryptedWinBoxCdb(readFixture("min.cdb"))).toThrow(
			"Expected an encrypted WinBox CDB file",
		);
	});
});

function parseFixture(name: string) {
	return parseWinBoxCdb(readFixture(name));
}

function readFixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(new URL(name, fixtureRoot)));
}

function findField(record: WinBoxCdbRecord | undefined, tag: number) {
	return record?.fields.find((field) => field.tag === tag);
}

const openFixtureNames = [
	"admin-nosaved-password-no-group.cdb",
	"admin-nosaved-password-profile-none.cdb",
	"admin-with-saved-empty-password-profile-none.cdb",
	"admin-with-saved-empty-password-profile-owne.cdb",
	"min.cdb",
	"romon-mac-saved-with-no-password-enabled-with-winbox-proxy-using-claude-saved.cdb",
	"romon-mac-saved-with-winbox-proxy-using-claude-saved-with-password.cdb",
	"user-with-no-saved-password-profile-own-with-group-mygroup-with-comment-mycomment.cdb",
	"user-with-saved-123-password-profile-none.cdb",
	"user-with-saved-123-password-profile-own-with-group-mygroup-with-comment-mycomment-and-admin-nopassword-on-same-ip-address-shows-two-entries.cdb",
	"user-with-saved-123-password-profile-own-with-group-mygroup-with-comment-mycomment-and-admin-nopassword-on-same-ip-address-with-saved-password-on-admin-shows-two-entries.cdb",
	"user-with-saved-123-password-profile-own-with-group-mygroup-with-comment-mycomment-and-admin-nopassword-on-same-ip-address-with-saved-password-with-comments-with-group-on-admin-shows-two-entries.cdb",
	"user-with-saved-123-password-profile-own-with-group-mygroup-with-comment-mycomment.cdb",
	"user-with-saved-123-password-profile-own-with-group-mygroup.cdb",
	"user-with-saved-123-password-profile-own.cdb",
	"using-mac-address-no-saved-password-no-group-no-comments.cdb",
	"using-mac-address-no-saved-password.cdb",
	"using-mac-address-with-saved-password.cdb",
] as const;
