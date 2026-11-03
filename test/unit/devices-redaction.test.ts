/**
 * #551: `devices show` / `add` / `set` withhold the record password by default
 * (text, JSON, library envelope) and always carry `passwordSet`;
 * `--show-password` / `showPassword: true` opts in. The dial path's use of the
 * stored password is covered in `resolver.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	type WinBoxCdbRecord,
	winBoxCdbFieldTag,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";
import {
	addDevice,
	type LoadedCdb,
	loadCdb,
	lookupDeviceRecord,
	REDACTED_PASSWORD_VALUE,
	renderDevicesEnvelope,
	setDevice,
	showDevice,
} from "../../src/devices.ts";
import { runCliCaptured } from "./cli-capture.ts";

const SECRET = "secret-551";

function record(target: string, password: string): WinBoxCdbRecord {
	return buildWinBoxCdbEntryRecord({
		recordType: winBoxCdbRecordType.ipAdmin,
		target,
		user: "admin",
		password,
		group: "lab",
	});
}

async function withCdb(
	records: readonly WinBoxCdbRecord[],
	fn: (path: string, cdb: LoadedCdb) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "centrs-redact-"));
	const path = join(dir, "winbox.cdb");
	try {
		await writeFile(path, encodeOpenWinBoxCdb(records));
		await fn(path, await loadCdb({ cdbFile: path, env: {} }));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function parseJson(out: string): {
	ok: boolean;
	data: { entry?: Record<string, unknown>; record?: unknown };
} {
	return JSON.parse(out);
}

describe("devices password redaction — library (#551)", () => {
	test("showDevice withholds the password and reports passwordSet", async () => {
		await withCdb(
			[record("192.0.2.1", SECRET), record("192.0.2.2", "")],
			async (_path, cdb) => {
				const set = showDevice({ cdb, target: "192.0.2.1" }).data.entry;
				expect("password" in set).toBe(false);
				expect(set.passwordSet).toBe(true);
				// `savedPassword` is the WinBox keep-password flag, unrelated.
				expect(set.savedPassword).toBe(true);

				const unset = showDevice({ cdb, target: "192.0.2.2" }).data.entry;
				expect("password" in unset).toBe(false);
				expect(unset.passwordSet).toBe(false);
			},
		);
	});

	test("showDevice showPassword: true returns the password", async () => {
		await withCdb([record("192.0.2.1", SECRET)], async (_path, cdb) => {
			const entry = showDevice({
				cdb,
				target: "192.0.2.1",
				showPassword: true,
			}).data.entry;
			expect(entry.password).toBe(SECRET);
			expect(entry.passwordSet).toBe(true);
		});
	});

	test("explain record redacts the password field unless showPassword", async () => {
		await withCdb([record("192.0.2.1", SECRET)], async (_path, cdb) => {
			const passwordValue = (r: WinBoxCdbRecord | undefined) =>
				r?.fields.find((f) => f.tag === winBoxCdbFieldTag.password)?.value;

			const hidden = showDevice({ cdb, target: "192.0.2.1", explain: true });
			expect(passwordValue(hidden.data.record)).toBe(REDACTED_PASSWORD_VALUE);
			expect(JSON.stringify(hidden)).not.toContain(SECRET);
			// The loaded CDB itself is untouched.
			expect(cdb.entries[0]?.password).toBe(SECRET);

			const shown = showDevice({
				cdb,
				target: "192.0.2.1",
				explain: true,
				showPassword: true,
			});
			expect(passwordValue(shown.data.record)).toBe(SECRET);
		});
	});

	test("addDevice / setDevice entries redact by default; showPassword opts in", async () => {
		await withCdb([record("192.0.2.1", SECRET)], async (path, cdb) => {
			const added = await addDevice({
				cdb,
				target: "198.51.100.1",
				user: "writer",
				password: SECRET,
			});
			expect(added.data.entry && "password" in added.data.entry).toBe(false);
			expect(added.data.entry?.passwordSet).toBe(true);
			expect(JSON.stringify(added)).not.toContain(SECRET);

			const reloaded = await loadCdb({ cdbFile: path, env: {} });
			const setResult = await setDevice({
				cdb: reloaded,
				target: "198.51.100.1",
				group: "edge",
			});
			expect(setResult.data.entry && "password" in setResult.data.entry).toBe(
				false,
			);
			expect(setResult.data.entry?.passwordSet).toBe(true);

			const again = await loadCdb({ cdbFile: path, env: {} });
			const shown = await setDevice({
				cdb: again,
				target: "198.51.100.1",
				group: "core",
				showPassword: true,
			});
			expect(shown.data.entry?.password).toBe(SECRET);

			const third = await loadCdb({ cdbFile: path, env: {} });
			const addShown = await addDevice({
				cdb: third,
				target: "198.51.100.2",
				password: "other",
				showPassword: true,
			});
			expect(addShown.data.entry?.password).toBe("other");
		});
	});

	test("the internal raw lookup still carries the stored password", async () => {
		await withCdb([record("192.0.2.1", SECRET)], async (_path, cdb) => {
			const found = lookupDeviceRecord({ cdb, target: "192.0.2.1" });
			expect(found.entry.password).toBe(SECRET);
			expect(found.cdbRecordIndex).toBe(0);
		});
	});

	test("explain withholds a rawTail that may hold the password (#609 review)", async () => {
		// An unknown tcode before tag 3: the decoder folds the rest of the record,
		// password included, into one opaque tail, and `entry.password` is "".
		const built = record("192.0.2.1", SECRET);
		const passwordAt = built.fields.findIndex(
			(f) => f.tag === winBoxCdbFieldTag.password,
		);
		const tailBytes = Uint8Array.from([
			0x03,
			0x00,
			0x00,
			0x21,
			SECRET.length,
			...new TextEncoder().encode(SECRET),
		]);
		const tailed: WinBoxCdbRecord = {
			...built,
			fields: [
				...built.fields.slice(0, passwordAt),
				{
					tag: 200,
					marker: 0x00,
					tcode: 0x7f,
					value: tailBytes,
					rawTail: true,
				},
			],
		};
		const secretHex = Array.from(new TextEncoder().encode(SECRET))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join(" ");
		await withCdb([tailed], async (_path, cdb) => {
			const hidden = showDevice({ cdb, target: "192.0.2.1", explain: true });
			const tail = hidden.data.record?.fields.find((f) => f.rawTail);
			expect(tail?.value).toBe(
				`<redacted: ${tailBytes.length} bytes, may contain password>`,
			);
			const json = JSON.stringify(hidden);
			expect(json).not.toContain(SECRET);
			const text = renderDevicesEnvelope(hidden, "text");
			expect(text).not.toContain(SECRET);
			expect(text).not.toContain(secretHex);
			expect(text).not.toContain(secretHex.slice(0, 11));
			// The decoded password is empty, so passwordSet is false — and the
			// load warning says the tail may hold one.
			expect(hidden.data.entry.passwordSet).toBe(false);
			const warning = hidden.warnings.find(
				(w) => w.code === "cdb/unknown-field",
			);
			expect(warning?.context?.["mayContainPassword"]).toBe(true);

			const shown = showDevice({
				cdb,
				target: "192.0.2.1",
				explain: true,
				showPassword: true,
			});
			expect(shown.data.record?.fields.find((f) => f.rawTail)?.value).toEqual(
				tailBytes,
			);
		});
	});

	test("a rawTail after a decoded password keeps its bytes", async () => {
		const tail = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]);
		const trailing = buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "192.0.2.1",
			user: "admin",
			password: SECRET,
			extraFields: [
				{ tag: 200, marker: 0x00, tcode: 0x7f, value: tail, rawTail: true },
			],
		});
		await withCdb([trailing], async (_path, cdb) => {
			const hidden = showDevice({ cdb, target: "192.0.2.1", explain: true });
			expect(hidden.data.record?.fields.find((f) => f.rawTail)?.value).toEqual(
				tail,
			);
			expect(JSON.stringify(hidden)).not.toContain(SECRET);
			const warning = hidden.warnings.find(
				(w) => w.code === "cdb/unknown-field",
			);
			expect(warning?.context?.["mayContainPassword"]).toBeUndefined();
		});
	});

	test("--show-password text renders an empty password as (not set)", async () => {
		await withCdb([record("192.0.2.2", "")], async (_path, cdb) => {
			const text = renderDevicesEnvelope(
				showDevice({ cdb, target: "192.0.2.2", showPassword: true }),
				"text",
			);
			expect(text).toContain("password:      (not set)");
		});
	});

	test("text rendering never prints a withheld password", async () => {
		await withCdb([record("192.0.2.1", SECRET)], async (_path, cdb) => {
			const text = renderDevicesEnvelope(
				showDevice({ cdb, target: "192.0.2.1", explain: true }),
				"text",
			);
			expect(text).not.toContain(SECRET);
			expect(text).toContain("password:      (set, hidden)");
		});
	});
});

describe("devices password redaction — CLI (#551)", () => {
	test("devices show: JSON and text withhold the password by default", async () => {
		await withCdb([record("192.0.2.1", SECRET)], async (path) => {
			const json = await runCliCaptured([
				"devices",
				"show",
				"192.0.2.1",
				"--cdb-file",
				path,
				"--json",
			]);
			expect(json.code).toBe(0);
			expect(json.out).not.toContain(SECRET);
			const entry = parseJson(json.out).data.entry;
			expect(entry?.["passwordSet"]).toBe(true);
			expect(entry && "password" in entry).toBe(false);

			const text = await runCliCaptured([
				"devices",
				"show",
				"192.0.2.1",
				"--cdb-file",
				path,
			]);
			expect(text.code).toBe(0);
			expect(text.out).not.toContain(SECRET);
			expect(text.out).toContain("password:      (set, hidden)");
		});
	});

	test("devices show --show-password returns it in JSON and text", async () => {
		await withCdb([record("192.0.2.1", SECRET)], async (path) => {
			const json = await runCliCaptured([
				"devices",
				"show",
				"192.0.2.1",
				"--cdb-file",
				path,
				"--show-password",
				"--json",
			]);
			expect(json.code).toBe(0);
			const entry = parseJson(json.out).data.entry;
			expect(entry?.["password"]).toBe(SECRET);
			expect(entry?.["passwordSet"]).toBe(true);

			const text = await runCliCaptured([
				"devices",
				"show",
				"192.0.2.1",
				"--cdb-file",
				path,
				"--show-password",
			]);
			expect(text.out).toContain(`password:      ${SECRET}`);
		});
	});

	test("devices add / set: redacted by default, --show-password opts in", async () => {
		await withCdb([record("192.0.2.1", SECRET)], async (path) => {
			const add = await runCliCaptured([
				"devices",
				"add",
				"198.51.100.1",
				"--user",
				"writer",
				"--password",
				SECRET,
				"--cdb-file",
				path,
				"--json",
			]);
			expect(add.code).toBe(0);
			expect(add.out).not.toContain(SECRET);
			expect(parseJson(add.out).data.entry?.["passwordSet"]).toBe(true);

			const setText = await runCliCaptured([
				"devices",
				"set",
				"198.51.100.1",
				"--group",
				"edge",
				"--cdb-file",
				path,
			]);
			expect(setText.code).toBe(0);
			expect(setText.out).not.toContain(SECRET);
			expect(setText.out).toContain("password:      (set, hidden)");

			const setShown = await runCliCaptured([
				"devices",
				"set",
				"198.51.100.1",
				"--group",
				"core",
				"--cdb-file",
				path,
				"--show-password",
				"--json",
			]);
			expect(setShown.code).toBe(0);
			expect(parseJson(setShown.out).data.entry?.["password"]).toBe(SECRET);

			const addShown = await runCliCaptured([
				"devices",
				"add",
				"198.51.100.2",
				"--password",
				"other",
				"--cdb-file",
				path,
				"--show-password",
				"--json",
			]);
			expect(addShown.code).toBe(0);
			expect(parseJson(addShown.out).data.entry?.["password"]).toBe("other");
		});
	});

	for (const sub of ["list", "groups", "remove", "edit", "init"]) {
		test(`devices ${sub} refuses --show-password`, async () => {
			await withCdb([record("192.0.2.1", SECRET)], async (path) => {
				const args = ["devices", sub];
				if (sub === "remove" || sub === "edit") args.push("192.0.2.1");
				args.push("--cdb-file", path, "--show-password", "--json");
				const result = await runCliCaptured(args);
				expect(result.code).toBe(1);
				const envelope = JSON.parse(result.err) as {
					ok: boolean;
					error: { code: string; context?: Record<string, unknown> };
				};
				expect(envelope.ok).toBe(false);
				expect(envelope.error.code).toBe("input/invalid-command");
				expect(envelope.error.context?.["flag"]).toBe("--show-password");
				expect(result.out).not.toContain(SECRET);
			});
		});
	}
});
