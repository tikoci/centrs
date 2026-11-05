/**
 * Real-CHR control for snapshot-based CHR reuse (#612, `chr-reuse.ts`).
 *
 * The unit tier (`test/unit/chr-reuse.test.ts`) covers lease and failure logic
 * against fakes. This file proves the contract that only a real guest can:
 * a restore rewinds guest configuration AND guest files, fresh REST and native
 * API connections work after it, `--quickchr <name>` still resolves the leased
 * machine, a lease release does not delete the VM, and a failed `loadvm` takes
 * the replacement path instead of handing out the suspect router.
 */

import { describe, expect, test } from "bun:test";
import {
	connectNativeApi,
	readAttribute,
} from "../../src/protocols/native-api.ts";
import {
	bootIntegrationChr,
	isChrIntegrationEnabled,
	isChrReuseEnabled,
	quickChrReuseHooks,
	REUSE_BOOT_OPTIONS,
	readEnv,
	splitQuickChrAuth,
	startIntegrationChr,
	withBootReadyRetry,
} from "./chr.ts";
import { createChrReuse } from "./chr-reuse.ts";
import { runCliProcess } from "./cli-process.ts";

const describeReuse =
	isChrIntegrationEnabled() && isChrReuseEnabled() ? describe : describe.skip;

/**
 * The replacement control boots two CHRs (~56 s on CI) to prove a path the unit
 * tier already covers against fakes. GitHub runs it only on the scheduled QA
 * run; local runs always include it.
 */
const skipReplacementControl =
	process.env["GITHUB_EVENT_NAME"] !== undefined &&
	process.env["GITHUB_EVENT_NAME"] !== "schedule";

const PROBE_FILE = "centrs-reuse-probe";
const DIRTY_IDENTITY = "centrs-reuse-dirty";

async function identityOf(chr: {
	rest(path: string): Promise<unknown>;
}): Promise<string> {
	const record = (await chr.rest("/system/identity")) as { name?: string };
	return String(record.name);
}

async function probeFileNames(chr: {
	rest(path: string): Promise<unknown>;
}): Promise<string[]> {
	const rows = (await chr.rest("/file")) as { name?: string }[];
	return rows
		.map((row) => String(row.name))
		.filter((name) => name.includes(PROBE_FILE));
}

describeReuse("CHR reuse: snapshot restore against CHR (#612)", () => {
	test("each lease starts from the baseline: config and files rewound, services usable", async () => {
		const first = await startIntegrationChr({}, { reuse: true });
		const name = first.chr.name;
		let baselineIdentity: string;
		try {
			baselineIdentity = await identityOf(first.chr);
			expect(baselineIdentity).not.toBe(DIRTY_IDENTITY);

			// Dirty the guest: a config change and a file on its disk.
			await first.chr.exec(`/system/identity/set name=${DIRTY_IDENTITY}`);
			await first.chr.exec(`/export file=${PROBE_FILE}`);
			const deadline = Date.now() + 15_000;
			while ((await probeFileNames(first.chr)).length === 0) {
				if (Date.now() > deadline) throw new Error("probe file never appeared");
				await Bun.sleep(500);
			}
			expect(await identityOf(first.chr)).toBe(DIRTY_IDENTITY);
		} finally {
			// Releases the lease; must NOT remove the VM.
			await first.chr.destroy();
		}

		for (let cycle = 0; cycle < 3; cycle++) {
			const next = await startIntegrationChr({}, { reuse: true });
			try {
				// Same machine: the release did not delete it.
				expect(next.chr.name).toBe(name);
				expect(await identityOf(next.chr)).toBe(baselineIdentity);
				expect(await probeFileNames(next.chr)).toEqual([]);

				// A fresh native API session works after the restore.
				const auth = splitQuickChrAuth(
					readEnv(next.env, "QUICKCHR_AUTH") ?? "admin:",
				);
				const { session } = await withBootReadyRetry(() =>
					connectNativeApi({
						host: "127.0.0.1",
						port: next.chr.ports.api,
						username: auth.username,
						password: auth.password,
					}),
				);
				try {
					const replies = await session.talk({
						command: "/system/identity/print",
					});
					const record = replies.find((reply) => reply.type === "!re");
					expect(record ? readAttribute(record, "name") : undefined).toBe(
						baselineIdentity,
					);
				} finally {
					session.close();
				}

				// `--quickchr <name>` still resolves the leased machine.
				const cli = await runCliProcess({
					args: ["retrieve", "--quickchr", name, "/system/identity", "--json"],
					env: next.env,
				});
				expect(cli.exitCode).toBe(0);
				expect(JSON.parse(cli.stdoutText).ok).toBe(true);

				// Dirty it again so the next cycle proves another rewind.
				await next.chr.exec(`/system/identity/set name=${DIRTY_IDENTITY}`);
			} finally {
				await next.chr.destroy();
			}
		}
	}, 300_000);

	test.skipIf(skipReplacementControl)(
		"a failed loadvm discards the router and boots one replacement",
		async () => {
			const logs: string[] = [];
			const hooks = quickChrReuseHooks(
				() => bootIntegrationChr(REUSE_BOOT_OPTIONS),
				(message) => logs.push(message),
			);
			// A real loadvm against a snapshot that does not exist: QEMU refuses it,
			// and quickchr resumes the guest before throwing. Count the rejection
			// here rather than matching quickchr's error text, so a different
			// message (a monitor timeout, say) cannot fail the control, and a later
			// readiness failure cannot pass it.
			let loadRejections = 0;
			const reuse = createChrReuse({
				...hooks,
				async restoreBaseline(chr) {
					try {
						await chr.snapshot.load("centrs-no-such-snapshot");
					} catch (error) {
						loadRejections += 1;
						throw error;
					}
				},
			});
			try {
				const first = await reuse.acquire();
				expect(first).toBeDefined();
				const firstInstance = first?.instance;
				first?.release();

				const second = await reuse.acquire();
				expect(second).toBeDefined();
				// A new instance from a second boot; quickchr may reuse the freed name.
				expect(second?.instance).not.toBe(firstInstance);
				expect(reuse.stats.boots).toBe(2);
				expect(reuse.stats.replacements).toBe(1);
				expect(loadRejections).toBe(1);
				// centrs's own discard log, not quickchr's wording.
				expect(
					logs.some((line) => line.includes("restoring the baseline failed")),
				).toBe(true);
				// The replacement is a usable router.
				expect(await second?.instance.waitForBoot(30_000)).toBe(true);
				second?.release();

				// The budget is spent: the next failed restore fails closed.
				await expect(reuse.acquire()).rejects.toThrow(/replacement budget/);
			} finally {
				await reuse.dispose();
			}
		},
		300_000,
	);
});
