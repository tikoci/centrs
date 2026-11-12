/**
 * `transfer` against files under a RouterOS container root (#636).
 *
 * `/file print` lists a container's `root-dir` (type `container store`) but
 * none of its children, so a lookup by listing loses files that exist. A
 * direct `/file/get .id=<pathname>` still answers for them, and pathname-
 * addressed `set` and `remove` work. This proves transfer's upload, overwrite,
 * download and remove there over rest-api and native-api.
 *
 * The container is created from a committed `FROM scratch` image tar
 * (`test/fixtures/container/`), so no registry is contacted and the container
 * never needs to run.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transferEnvelope } from "../../src/transfer.ts";
import { HERMETIC_ENV } from "../unit/hermetic-env.ts";
import {
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

const IMAGE = new URL(
	"../fixtures/container/scratch-hello.tar",
	import.meta.url,
).pathname;
const ROOT = "centrs-ct-root";

async function waitFor(
	predicate: () => Promise<boolean>,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await Bun.sleep(500);
	}
	return predicate();
}

describeFast("transfer under a container root (#636)", () => {
	test("upload, overwrite, download and remove a file /file print does not list", async () => {
		const started = await startIntegrationChr({
			name: `centrs-ct-root-${Date.now()}`,
			packages: ["container"],
			deviceMode: { mode: "advanced", enable: ["container"] },
			bootSize: "512M",
		});
		const { chr } = started;
		const work = await mkdtemp(join(tmpdir(), "centrs-ct-root-"));
		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const base = {
				targetInput: chr.restUrl,
				username: auth.username,
				password: auth.password,
			};
			const transports = [
				{ via: "rest-api" },
				{ via: "native-api", port: chr.ports.api },
			] as const;

			// Container root from the committed image: upload the tar, add.
			const imageUp = await transferEnvelope(
				{ ...base, verb: "upload", local: IMAGE, remote: "scratch-hello.tar" },
				HERMETIC_ENV,
			);
			expect(imageUp.ok, JSON.stringify(imageUp)).toBe(true);
			for (const command of [
				"/interface/veth/add name=veth-ct636 address=172.28.0.2/24 gateway=172.28.0.1",
				`/container/add file=scratch-hello.tar interface=veth-ct636 root-dir=${ROOT} name=ct636`,
			]) {
				const out = JSON.stringify(await chr.exec(command));
				expect(out, command).not.toMatch(/error|failure/i);
			}
			// Imported once `image-id` is set and the container sits stopped.
			const extracted = await waitFor(async () => {
				const rows = (await chr.rest("/container")) as Array<
					Record<string, string>
				>;
				const row = rows.find((r) => r["name"] === "ct636");
				return Boolean(row?.["image-id"]) && row?.["stopped"] === "true";
			}, 120_000);
			expect(
				extracted,
				`container image never finished extracting: ${JSON.stringify(await chr.rest("/container"))}`,
			).toBe(true);

			// The listing shows the root but not its children (the #636 premise).
			const listed = (await chr.rest("/file")) as Array<Record<string, string>>;
			expect(listed.some((row) => row["name"] === ROOT)).toBe(true);
			expect(listed.some((row) => row["name"] === `${ROOT}/hello.txt`)).toBe(
				false,
			);

			for (const { via, ...extra } of transports) {
				const remote = `${ROOT}/probe-${via}.txt`;
				const first = Buffer.from(`first ${via}\n`);
				const second = Buffer.from(`second, longer ${via}\n`);
				const firstPath = join(work, `first-${via}`);
				const secondPath = join(work, `second-${via}`);
				const back = join(work, `back-${via}`);
				await writeFile(firstPath, first);
				await writeFile(secondPath, second);
				const call = (request: Record<string, unknown>) =>
					transferEnvelope(
						{ ...base, ...extra, via, ...request } as Parameters<
							typeof transferEnvelope
						>[0],
						HERMETIC_ENV,
					);

				const up = await call({ verb: "upload", local: firstPath, remote });
				expect(up.ok, `${via} upload: ${JSON.stringify(up)}`).toBe(true);
				if (up.ok) {
					expect(up.data).toMatchObject({
						bytes: first.length,
						verified: "size",
					});
				}

				// Still hidden from the listing, but transfer sees it exists.
				const again = await call({ verb: "upload", local: firstPath, remote });
				expect(again.ok).toBe(false);
				if (!again.ok) expect(again.error.code).toBe("usage/target-exists");

				const forced = await call({
					verb: "upload",
					local: secondPath,
					remote,
					force: true,
				});
				expect(forced.ok, `${via} --force: ${JSON.stringify(forced)}`).toBe(
					true,
				);
				if (forced.ok) {
					expect(forced.data).toMatchObject({
						bytes: second.length,
						verified: "size",
					});
				}

				const down = await call({ verb: "download", remote, local: back });
				expect(down.ok, `${via} download: ${JSON.stringify(down)}`).toBe(true);
				expect((await readFile(back)).equals(second)).toBe(true);

				const removed = await call({ verb: "remove", remote });
				expect(removed.ok, `${via} remove: ${JSON.stringify(removed)}`).toBe(
					true,
				);
				const gone = await call({
					verb: "download",
					remote,
					local: join(work, `gone-${via}`),
				});
				expect(gone.ok).toBe(false);
				if (!gone.ok) expect(gone.error.code).toBe("routeros/command-failed");
			}

			// The image's own file is readable through the same path.
			const hello = await transferEnvelope(
				{
					...base,
					verb: "download",
					remote: `${ROOT}/hello.txt`,
					local: join(work, "hello.txt"),
				},
				HERMETIC_ENV,
			);
			expect(hello.ok, JSON.stringify(hello)).toBe(true);
			expect(await readFile(join(work, "hello.txt"), "utf8")).toBe(
				"centrs #636 fixture\n",
			);

			const resource = (await chr.rest("/system/resource")) as Record<
				string,
				string
			>;
			await recordIntegrationEvidence({
				suite: "transfer under a container root (#636)",
				command: "transfer",
				protocol: "rest-api",
				routerosVersion: resource["version"] ?? chr.state.version,
				boardName: resource["board-name"],
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [],
			});
		} finally {
			await chr.destroy();
		}
	}, 600_000);
});
