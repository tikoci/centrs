import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWinBoxCdbOpen } from "../../src/data/winbox-cdb.ts";
import { loadCdb } from "../../src/devices.ts";
import type { CentrsError } from "../../src/errors.ts";

describe("default CDB auto-create", () => {
	test("creates an empty open CDB at the default path on first run", async () => {
		const home = await mkdtemp(join(tmpdir(), "centrs-home-"));
		try {
			const cdb = await loadCdb({ env: { HOME: home } });
			expect(cdb.entries).toEqual([]);
			// A `cdb/created` warning announces the first-run creation.
			expect(cdb.warnings.some((w) => w.code === "cdb/created")).toBe(true);

			const created = join(home, ".config/tikoci/winbox.cdb");
			const info = await stat(created);
			expect(info.isFile()).toBe(true);
			const bytes = new Uint8Array(await Bun.file(created).arrayBuffer());
			expect(isWinBoxCdbOpen(bytes)).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("does not warn on subsequent runs once the CDB exists", async () => {
		const home = await mkdtemp(join(tmpdir(), "centrs-home-"));
		try {
			await loadCdb({ env: { HOME: home } });
			const second = await loadCdb({ env: { HOME: home } });
			expect(second.warnings.some((w) => w.code === "cdb/created")).toBe(false);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("still errors for an explicit missing --cdb-file path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-home-"));
		try {
			const missing = join(dir, "nope.cdb");
			let caught: CentrsError | undefined;
			try {
				await loadCdb({ cdbFile: missing, env: {} });
			} catch (error) {
				caught = error as CentrsError;
			}
			expect(caught?.code).toBe("cdb/not-found");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("still errors for an explicit missing CENTRS_CDB_FILE path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-home-"));
		try {
			const missing = join(dir, "nope.cdb");
			let caught: CentrsError | undefined;
			try {
				await loadCdb({ env: { CENTRS_CDB_FILE: missing } });
			} catch (error) {
				caught = error as CentrsError;
			}
			expect(caught?.code).toBe("cdb/not-found");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("surfaces cdb/parse-failed with parse context for a corrupt CDB", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-home-"));
		try {
			const corrupt = join(dir, "corrupt.cdb");
			// open magic + a u32 record length of 100 with no record bytes: the
			// codec underflows reading the claimed record slice.
			await Bun.write(
				corrupt,
				Uint8Array.from([0x0d, 0xf0, 0x1d, 0xc0, 0x64, 0x00, 0x00, 0x00]),
			);
			let caught: CentrsError | undefined;
			try {
				await loadCdb({ cdbFile: corrupt, env: {} });
			} catch (error) {
				caught = error as CentrsError;
			}
			expect(caught?.code).toBe("cdb/parse-failed");
			expect(caught?.context?.["parseKind"]).toBe("underflow");
			expect(caught?.context?.["parseStructure"]).toBe("slice");
			expect(caught?.context?.["parseRequested"]).toBe(100);
			expect(caught?.context?.["cdbFile"]).toBe(corrupt);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
