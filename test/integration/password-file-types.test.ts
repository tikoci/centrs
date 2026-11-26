/**
 * #672 / PR #674 review: a password-file path that is not a regular file.
 *
 * Network-free, so it runs in the fast `bun test` gate like the CLI smoke
 * tier. POSIX only (it makes a FIFO with `mkfifo` and reads `/dev/zero`),
 * which is why it lives here and not in `test/unit/`. A FIFO with no writer
 * used to block the synchronous read, stalling a whole MCP process, and a
 * device would stream forever. Both are refused without reading.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CentrsError } from "../../src/errors.ts";
import {
	CDB_PASSWORD_SECRET,
	readSecretFile,
	TARGET_PASSWORD_SECRET,
} from "../../src/resolver/secret-source.ts";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe.skipIf(process.platform === "win32")(
	"password files that are not regular files",
	() => {
		test("a FIFO or a device is refused at once, not read", async () => {
			const dir = await mkdtemp(join(tmpdir(), "centrs-password-types-"));
			dirs.push(dir);
			const fifo = join(dir, "fifo");
			expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
			for (const [spec, code] of [
				[CDB_PASSWORD_SECRET, "cdb/password-unavailable"],
				[TARGET_PASSWORD_SECRET, "auth/password-unavailable"],
			] as const) {
				for (const path of [fifo, "/dev/zero"]) {
					let error: unknown;
					try {
						readSecretFile(spec, {
							kind: "file",
							path,
							source: { kind: "file", key: spec.fileEnvKey },
						});
					} catch (caught) {
						error = caught;
					}
					expect(error).toBeInstanceOf(CentrsError);
					expect((error as CentrsError).code).toBe(code);
					expect((error as CentrsError).summary).toContain(
						"is not a regular file",
					);
				}
			}
		}, 5_000);
	},
);
