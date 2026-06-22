import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildTargetSelectionTips,
	cdbInputsFromArgs,
	formatTipsText,
	isMissingTargetError,
	missingTargetError,
} from "../../src/cli/missing-target.ts";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";
import { CentrsError } from "../../src/errors.ts";

async function cdbFile(
	records: readonly Parameters<typeof encodeOpenWinBoxCdb>[0][number][],
): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "centrs-missing-target-"));
	const path = join(dir, "winbox.cdb");
	await writeFile(path, encodeOpenWinBoxCdb(records));
	return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("isMissingTargetError", () => {
	test("true only for a missing-target-tagged error", () => {
		expect(
			isMissingTargetError(
				missingTargetError({
					command: "terminal",
					summary: "needs a router",
					remediation: "pass one",
				}),
			),
		).toBe(true);
		expect(
			isMissingTargetError(
				new CentrsError({ code: "input/invalid-command", summary: "other" }),
			),
		).toBe(false);
		expect(isMissingTargetError(new Error("plain"))).toBe(false);
	});
});

describe("cdbInputsFromArgs", () => {
	test("pulls --cdb-file / --cdb-password out of raw args", () => {
		expect(
			cdbInputsFromArgs(["x", "--cdb-file", "/a.cdb", "--cdb-password", "pw"]),
		).toEqual({ cdbFile: "/a.cdb", cdbPassword: "pw" });
		expect(cdbInputsFromArgs(["--cdb-file"])).toEqual({});
	});
});

describe("buildTargetSelectionTips", () => {
	test("empty registry tips toward discover --save", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-empty-home-"));
		try {
			const tips = await buildTargetSelectionTips({ env: { HOME: dir } });
			expect(tips).toHaveLength(1);
			expect(tips[0]?.code).toBe("tip/no-devices");
			expect(tips[0]?.fix).toContain("centrs discover --save");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("populated registry lists saved handles (identity over target)", async () => {
		const { path, cleanup } = await cdbFile([
			buildWinBoxCdbEntryRecord({
				recordType: winBoxCdbRecordType.ipAdmin,
				target: "192.0.2.10",
				user: "admin",
				comment: "identity=edge-router",
			}),
			buildWinBoxCdbEntryRecord({
				recordType: winBoxCdbRecordType.ipAdmin,
				target: "192.0.2.11",
				user: "admin",
			}),
			// The reserved fallback record must not be offered as a <router>.
			buildWinBoxCdbEntryRecord({
				recordType: winBoxCdbRecordType.ipAdmin,
				target: "__default__",
				user: "admin",
			}),
		]);
		try {
			const tips = await buildTargetSelectionTips({ cdbFile: path });
			expect(tips).toHaveLength(1);
			expect(tips[0]?.code).toBe("tip/select-target");
			expect(tips[0]?.message).toContain("edge-router");
			expect(tips[0]?.message).toContain("192.0.2.11");
			expect(tips[0]?.message).toContain("2 saved device");
			expect(tips[0]?.message).not.toContain("__default__");
		} finally {
			await cleanup();
		}
	});
});

describe("formatTipsText", () => {
	test("renders a Tips footer, empty string for no tips", () => {
		expect(formatTipsText([])).toBe("");
		const text = formatTipsText([
			{ code: "tip/x", message: "msg", fix: "do it" },
		]);
		expect(text).toContain("Tips:");
		expect(text).toContain("[tip/x] msg");
		expect(text).toContain("fix: do it");
	});
});
