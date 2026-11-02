/**
 * #586 on real RouterOS (commands/retrieve/examples.md RP1–RP2): a read
 * surface never dispatches a non-read.
 *
 * Before the fix, `retrieve '/system/reboot#' --no-validate --attribute uptime`
 * posted `/rest/system/reboot` and rebooted CHR 7.24.5, and `api` with a
 * projection did the same. This boots one CHR and checks two things:
 *
 * 1. Paths that would cut the appended `/print` off the URL (`#`, `?`) are
 *    refused before dispatch, over REST and native API, `retrieve` and `api`.
 * 2. Without injection, the appended `/print` is the guarantee: RouterOS
 *    answers `<command>/print` (and a GET of a command) with "no such command",
 *    so `/system/reboot` and `/system/reset-configuration` read as a typed
 *    failure even with validation off.
 *
 * The router's uptime must not go backwards across the whole run.
 */
import { describe, expect, test } from "bun:test";
import { api, CentrsError, retrieve } from "../../src/index.ts";
import {
	isChrIntegrationEnabled,
	readEnv,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

/** RouterOS uptime (`1w2d3h4m5s`) in seconds. */
function uptimeSeconds(value: unknown): number {
	const units: Record<string, number> = {
		w: 604_800,
		d: 86_400,
		h: 3_600,
		m: 60,
		s: 1,
	};
	let total = 0;
	for (const [, amount, unit] of String(value).matchAll(/(\d+)([a-z])/g)) {
		total += Number(amount) * (units[unit as string] ?? 0);
	}
	return total;
}

async function failureCode(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
	} catch (error) {
		return error instanceof CentrsError ? error.code : String(error);
	}
	return "succeeded";
}

describeFast("read surfaces never dispatch a non-read (#586)", () => {
	test("refuses URL-rewriting paths and relies on /print otherwise", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const restPort = Number(new URL(chr.restUrl).port);
			const target = {
				host: "127.0.0.1",
				username: auth.username,
				password: auth.password,
				timeout: "5s",
				validate: false,
			};
			const transports = [
				{ via: "rest-api", port: restPort },
				{ via: "native-api", port: chr.ports.api },
			];
			const readUptime = async () =>
				uptimeSeconds(
					((await chr.rest("/system/resource")) as { uptime?: unknown }).uptime,
				);
			const before = await readUptime();

			for (const transport of transports) {
				for (const path of [
					"/system/reboot#",
					"/system/reboot?",
					"/system/reset-configuration#",
				]) {
					expect(
						await failureCode(() =>
							retrieve({
								...target,
								...transport,
								path,
								attribute: "uptime",
							}),
						),
					).toBe("input/invalid-routeros-path");
					expect(
						await failureCode(() =>
							api({
								...target,
								...transport,
								endpoint: path,
								proplist: ["uptime"],
							}),
						),
					).toBe("input/invalid-routeros-path");
				}

				// Well-formed command paths reach RouterOS, which refuses
				// `<command>/print`: the failure is RouterOS's, not a dispatch.
				for (const path of ["/system/reboot", "/system/reset-configuration"]) {
					for (const attribute of [undefined, "uptime"]) {
						const code = await failureCode(() =>
							retrieve({ ...target, ...transport, path, attribute }),
						);
						expect(code).not.toBe("succeeded");
						expect(code.startsWith("routeros/")).toBe(true);
					}
				}
			}

			// Wait out a reboot that would have started: RouterOS acks the
			// request before it goes down, so an immediate read can still land.
			// A regression leaves REST down while it reboots, so poll until it
			// answers and report the uptime, not a transport error.
			await Bun.sleep(5_000);
			let after: number | undefined;
			const deadline = Date.now() + 120_000;
			while (after === undefined && Date.now() < deadline) {
				try {
					after = await readUptime();
				} catch {
					await Bun.sleep(2_000);
				}
			}
			expect(after).toBeDefined();
			expect(after ?? 0).toBeGreaterThanOrEqual(before);
		} finally {
			await chr.destroy();
		}
	}, 300_000);
});
