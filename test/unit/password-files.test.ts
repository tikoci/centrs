/**
 * #672: the CDB key and the target password read from a file
 * (`--cdb-password-file` / `CENTRS_CDB_PASSWORD_FILE`,
 * `--password-file` / `CENTRS_PASSWORD_FILE`), as `/run/secrets` provides.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { btestServer } from "../../src/btest.ts";
import { parseExplainCliArgs } from "../../src/cli/explain.ts";
import { discover } from "../../src/discover.ts";
import { CentrsError } from "../../src/errors.ts";
import {
	addDevice,
	initCdb,
	listDevices,
	loadCdb,
	resolveAuth,
	resolveCdb,
	retrieveEnvelope,
} from "../../src/index.ts";
import { resolveMcpConfig } from "../../src/mcp/config.ts";
import { loadAllowlistCdb } from "../../src/mcp/safety.ts";
import { loadEnvFileDefaults } from "../../src/resolver/config-file.ts";
import {
	CDB_PASSWORD_SECRET,
	chooseSecret,
	readSecretFile,
	TARGET_PASSWORD_SECRET,
} from "../../src/resolver/secret-source.ts";
import { settingsPrint } from "../../src/settings.ts";
import { closedPort } from "./closed-port.ts";
import { HERMETIC_ENV } from "./hermetic-env.ts";

const KEY = "cdb-key-Zq81-never-printed";
const ROUTER_PW = "router-pw-Lk22-never-printed";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function sandbox(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "centrs-password-files-"));
	dirs.push(dir);
	return dir;
}

async function caught(run: () => unknown): Promise<CentrsError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof CentrsError) return error;
		throw error;
	}
	throw new Error("expected a CentrsError");
}

describe("chooseSecret", () => {
	test("value and file in one tier conflict; flags outrank env", () => {
		expect(() =>
			chooseSecret(CDB_PASSWORD_SECRET, { value: "a", file: "/f" }, {}),
		).toThrow(expect.objectContaining({ code: "usage/conflicting-flags" }));
		expect(() =>
			chooseSecret(
				TARGET_PASSWORD_SECRET,
				{},
				{ CENTRS_PASSWORD: "a", CENTRS_PASSWORD_FILE: "/f" },
			),
		).toThrow(expect.objectContaining({ code: "usage/conflicting-flags" }));
		// A flag beats an image-wide env default without a conflict.
		expect(
			chooseSecret(
				CDB_PASSWORD_SECRET,
				{ value: "a" },
				{ CENTRS_CDB_PASSWORD_FILE: "/run/secrets/k" },
			),
		).toMatchObject({ kind: "value", source: { kind: "cli" } });
		expect(
			chooseSecret(
				CDB_PASSWORD_SECRET,
				{ file: "/f" },
				{ CENTRS_CDB_PASSWORD: "a" },
			),
		).toMatchObject({
			kind: "file",
			path: "/f",
			source: { kind: "file", key: "--cdb-password-file" },
		});
	});

	test("an empty *_FILE env value counts as unset", () => {
		expect(
			chooseSecret(
				CDB_PASSWORD_SECRET,
				{},
				{ CENTRS_CDB_PASSWORD_FILE: "", CENTRS_CDB_PASSWORD: "v" },
			),
		).toMatchObject({ kind: "value", value: "v" });
	});
});

describe("readSecretFile", () => {
	test("strips one trailing newline, like --password-stdin", async () => {
		const dir = await sandbox();
		const read = (path: string) =>
			readSecretFile(CDB_PASSWORD_SECRET, {
				kind: "file",
				path,
				source: { kind: "file", key: "CENTRS_CDB_PASSWORD_FILE" },
			});
		for (const [body, expected] of [
			[`${KEY}\n`, KEY],
			[`${KEY}\r\n`, KEY],
			[`${KEY}\n\n`, `${KEY}\n`],
			[` ${KEY} `, ` ${KEY} `],
		] as const) {
			const path = join(dir, "k");
			await writeFile(path, body);
			expect(read(path)).toBe(expected);
		}
	});

	test("missing, empty and BOM files are unavailable; errors name the path only", async () => {
		const dir = await sandbox();
		const missing = join(dir, "missing");
		const empty = join(dir, "empty");
		const bom = join(dir, "bom");
		await writeFile(empty, "\n");
		await writeFile(bom, `﻿${KEY}`);
		for (const path of [missing, empty, bom]) {
			const error = await caught(() =>
				readSecretFile(TARGET_PASSWORD_SECRET, {
					kind: "file",
					path,
					source: { kind: "file", key: "CENTRS_PASSWORD_FILE" },
				}),
			);
			expect(error.code).toBe("auth/password-unavailable");
			expect(error.context).toMatchObject({
				path,
				source: "CENTRS_PASSWORD_FILE",
			});
			expect(JSON.stringify(error.toJSON?.() ?? error)).not.toContain(KEY);
		}
	});
});

describe("CDB key from a file", () => {
	async function encryptedCdb() {
		const dir = await sandbox();
		const cdbFile = join(dir, "winbox.cdb");
		const keyFile = join(dir, "cdb_key");
		await writeFile(keyFile, `${KEY}\n`);
		await initCdb({ cdbFile, encrypt: true, cdbPasswordFile: keyFile });
		const cdb = await loadCdb({ cdbFile, cdbPasswordFile: keyFile });
		await addDevice({
			cdb,
			target: "10.9.9.9",
			user: "ops",
			password: ROUTER_PW,
		});
		return { dir, cdbFile, keyFile };
	}

	test("init --encrypt, load and write use the file; meta shows the source, never the key", async () => {
		const { cdbFile, keyFile } = await encryptedCdb();
		const cdb = await loadCdb({
			cdbFile,
			env: { CENTRS_CDB_PASSWORD_FILE: keyFile },
		});
		expect(cdb.encrypted).toBe(true);
		expect(cdb.entries.map((entry) => entry.target)).toEqual(["10.9.9.9"]);
		const envelope = listDevices({ cdb });
		expect(envelope.meta.settings["cdbPassword"]).toEqual({
			kind: "file",
			key: "CENTRS_CDB_PASSWORD_FILE",
		});
		const text = JSON.stringify(envelope);
		expect(text).not.toContain(KEY);
		expect(text).not.toContain(ROUTER_PW);
	});

	test("the file is read on each load: deleting it fails the next load", async () => {
		const { cdbFile, keyFile } = await encryptedCdb();
		const env = { CENTRS_CDB_PASSWORD_FILE: keyFile };
		await loadCdb({ cdbFile, env });
		await rm(keyFile);
		const error = await caught(() => loadCdb({ cdbFile, env }));
		expect(error.code).toBe("cdb/password-unavailable");
		expect(error.context).toMatchObject({ path: keyFile });
	});

	test("a missing key file with an open or absent CDB is a warning, not an error", async () => {
		const dir = await sandbox();
		const missing = join(dir, "not-mounted");
		const env = { HOME: dir, CENTRS_CDB_PASSWORD_FILE: missing };
		// Absent default CDB: created open, and the run succeeds.
		const created = await loadCdb({ env });
		expect(created.encrypted).toBe(false);
		const warning = created.warnings.find(
			(entry) => entry.code === "cdb/password-not-needed",
		);
		expect(warning?.context).toMatchObject({ path: missing, exists: false });
		// Open CDB, file present: not read, still the same warning.
		const present = join(dir, "present");
		await writeFile(present, KEY);
		const open = await loadCdb({
			env: { HOME: dir, CENTRS_CDB_PASSWORD_FILE: present },
		});
		expect(open.encrypted).toBe(false);
		expect(
			open.warnings.find((entry) => entry.code === "cdb/password-not-needed")
				?.context,
		).toMatchObject({ exists: true });
		expect(JSON.stringify(open.warnings)).not.toContain(KEY);
	});

	test("an encrypted CDB with a missing key file is cdb/password-unavailable", async () => {
		const { dir, cdbFile } = await encryptedCdb();
		const error = await caught(() =>
			loadCdb({ cdbFile, cdbPasswordFile: join(dir, "gone") }),
		);
		expect(error.code).toBe("cdb/password-unavailable");
		expect(error.remediation).not.toMatch(/ask the user/i);
	});

	test("centrs.env never supplies a *_FILE path", async () => {
		const dir = await sandbox();
		await Bun.write(
			join(dir, "tikoci", "centrs.env"),
			"CENTRS_CDB_PASSWORD_FILE=/home/u/.ssh/id_ed25519\nCENTRS_PASSWORD_FILE=/x\nCENTRS_FORMAT=json\n",
		);
		const config = await loadEnvFileDefaults({ XDG_CONFIG_HOME: dir });
		expect(config).toEqual({ CENTRS_FORMAT: "json" });
	});
});

describe("target password from a file", () => {
	const record = {
		target: "10.9.9.9",
		identity: "r1",
		username: "ops",
		password: "record-pw",
		recordIndex: 0,
		overrides: {},
		warnings: [],
	};

	test("outranks the CDB record and reports a file source", async () => {
		const dir = await sandbox();
		const file = join(dir, "pw");
		await writeFile(file, `${ROUTER_PW}\n`);
		const auth = resolveAuth({}, { CENTRS_PASSWORD_FILE: file }, record);
		expect(auth.password).toBe(ROUTER_PW);
		expect(auth.passwordSource).toEqual({
			kind: "file",
			key: "CENTRS_PASSWORD_FILE",
		});
	});

	test("a missing file is an error, never a fall back to the record", async () => {
		const dir = await sandbox();
		const error = await caught(() =>
			resolveAuth({ passwordFile: join(dir, "nope") }, {}, record),
		);
		expect(error.code).toBe("auth/password-unavailable");
	});

	test("the password never appears in a retrieve envelope", async () => {
		const dir = await sandbox();
		const file = join(dir, "pw");
		await writeFile(file, ROUTER_PW);
		const port = closedPort();
		const envelope = await retrieveEnvelope(
			{
				targetInput: `http://127.0.0.1:${port}`,
				path: "/system/resource",
				username: "admin",
				passwordFile: file,
			},
			HERMETIC_ENV,
		);
		expect(envelope.ok).toBe(false);
		expect(envelope.meta.settings["password"]).toEqual({
			kind: "file",
			key: "--password-file",
		});
		expect(JSON.stringify(envelope)).not.toContain(ROUTER_PW);
	});
});

describe("centrs mcp", () => {
	test("keeps the key file's path, not its contents, and re-reads it per load", async () => {
		const dir = await sandbox();
		const cdbFile = join(dir, "winbox.cdb");
		const keyFile = join(dir, "cdb_key");
		await writeFile(keyFile, KEY);
		await initCdb({ cdbFile, encrypt: true, cdbPasswordFile: keyFile });
		const config = resolveMcpConfig({
			cdbFile,
			env: { CENTRS_CDB_PASSWORD_FILE: keyFile },
		});
		expect(config.cdbPassword).toBeUndefined();
		expect(config.cdbPasswordFile).toBe(keyFile);
		expect(JSON.stringify(config)).not.toContain(KEY);
		expect((await loadAllowlistCdb(config)).encrypted).toBe(true);
		await rm(keyFile);
		const error = await caught(() => loadAllowlistCdb(config));
		expect(error.code).toBe("cdb/password-unavailable");
	});

	test("value and file both set is a startup usage error", () => {
		expect(() =>
			resolveMcpConfig({
				env: {
					CENTRS_CDB_PASSWORD: "v",
					CENTRS_CDB_PASSWORD_FILE: "/run/secrets/k",
				},
			}),
		).toThrow(expect.objectContaining({ code: "usage/conflicting-flags" }));
	});
});

describe("review follow-ups (#674)", () => {
	test("btest server: a missing file or a conflict is an error envelope", async () => {
		const dir = await sandbox();
		const missing = await btestServer({
			username: "u",
			passwordFile: join(dir, "nope"),
			env: {},
		});
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.error.code).toBe("auth/password-unavailable");
		}
		const conflict = await btestServer({
			username: "u",
			password: "p",
			passwordFile: join(dir, "nope"),
			env: {},
		});
		expect(conflict.ok).toBe(false);
		if (!conflict.ok)
			expect(conflict.error.code).toBe("usage/conflicting-flags");
	});

	test("discover --save: a key-source conflict is an envelope, before listening", async () => {
		let listened = false;
		const envelope = await discover({
			save: true,
			cdbPassword: "v",
			cdbPasswordFile: "/run/secrets/k",
			env: {},
			listen: async () => {
				listened = true;
				throw new Error("must not listen");
			},
		});
		expect(listened).toBe(false);
		expect(envelope.ok).toBe(false);
		if (!envelope.ok)
			expect(envelope.error.code).toBe("usage/conflicting-flags");
	});

	test("an env key file pins the lookup only when the CDB exists", async () => {
		const home = await sandbox();
		const keyFile = join(home, "cdb_key");
		await writeFile(keyFile, KEY);
		const env = { HOME: home, CENTRS_CDB_PASSWORD_FILE: keyFile };
		const input = { targetInput: "router.example.net" };
		// No CDB: literal host, nothing created (an image-wide default is safe).
		expect(await resolveCdb(input, env)).toBeUndefined();
		const cdbFile = join(home, ".config", "tikoci", "winbox.cdb");
		expect(await Bun.file(cdbFile).exists()).toBe(false);
		// Encrypted CDB present: a name it lacks is a miss, as with CENTRS_CDB_PASSWORD.
		await mkdir(join(home, ".config", "tikoci"), { recursive: true });
		await initCdb({ cdbFile, encrypt: true, cdbPasswordFile: keyFile });
		const error = await caught(() => resolveCdb(input, env));
		expect(error.code).toBe("cdb/not-found-target");
	});

	test("offline explain treats both file flags as live-only", () => {
		expect(
			parseExplainCliArgs(["/ip/route", "--password-file", "/x"]),
		).toMatchObject({ connectionFlag: "--password-file" });
		expect(
			parseExplainCliArgs(["/ip/route", "--cdb-password-file", "/x"]),
		).toMatchObject({ connectionFlag: "--cdb-password-file" });
	});

	test("settings print and a plain devices init say a key file was not needed", async () => {
		const dir = await sandbox();
		const cdbFile = join(dir, "winbox.cdb");
		const missing = join(dir, "not-mounted");
		const init = await initCdb({ cdbFile, cdbPasswordFile: missing });
		expect(init.warnings).toEqual([
			expect.objectContaining({
				code: "cdb/password-not-needed",
				context: expect.objectContaining({ exists: false }),
			}),
		]);
		const printed = await settingsPrint({
			cdbFile,
			cdbPasswordFile: missing,
			env: { XDG_CONFIG_HOME: dir, HOME: dir },
		});
		expect(printed.warnings.map((warning) => warning.code)).toContain(
			"cdb/password-not-needed",
		);
	});
});
