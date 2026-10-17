import { describe, expect, test } from "bun:test";
import { routerOsStringLiteral } from "../../src/core/routeros-string.ts";
import { explainCommand } from "../../src/explain.ts";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

const LOST = "context lost to an earlier unreadable statement";

interface Chr {
	exec(command: string): Promise<unknown>;
}

/** `:parse` on the exact bytes — its diagnostic, or the IL when it accepted. */
async function parseOf(chr: Chr, input: string): Promise<string> {
	const result = (await chr.exec(
		`:put [:parse ${routerOsStringLiteral(input)}]`,
	)) as { output?: unknown };
	return String(result.output ?? "")
		.replaceAll("\r\n", "\n")
		.trim();
}

/**
 * A verb-free bare path that neither offline table lists (#211). The device
 * reads the same shape both ways: `/terminal/cuu` is a command, and the
 * statement after it runs at the root; `/ip fire conn` is an abbreviated menu,
 * and the statement after it runs inside it. Offline abstains on both, so the
 * statement after it has no path.
 */
const ROWS: { input: string; il: string }[] = [
	{
		input: "/terminal/cuu\nprint",
		il: "(evl /terminal/cuu);(<%% bad command name print",
	},
	{
		input: "/terminal cuu\nadd name=x",
		il: "(evl /terminal/cuu);(<%% bad command name add",
	},
	{
		input: "/ip fire conn\nprint",
		il: "/ip/firewall/connection/;(evl /ip/firewall/connection/print)",
	},
	{
		input: "/ip/firewall/layer7\nadd name=x regexp=y",
		il: "/ip/firewall/layer7-protocol/;(evl /ip/firewall/layer7-protocol/add",
	},
];

describeFast("explain unlisted bare paths against CHR (#211)", () => {
	test("the same shape is a command or a menu, so offline abstains", async () => {
		const started = await startIntegrationChr();
		try {
			for (const { input, il } of ROWS) {
				expect({ input, il: await parseOf(started.chr, input) }).toEqual({
					input,
					il: expect.stringContaining(il),
				});
				const [first, next] = explainCommand(input, {}).structure.statements;
				expect({
					input,
					first: first?.resolution,
					next: next?.unresolved,
				}).toEqual({ input, first: "ambiguous", next: LOST });
			}

			// A known navigation after it recovers, on the device and offline.
			const recovered = "/terminal/cuu\n/ip address\nprint";
			expect(await parseOf(started.chr, recovered)).toContain(
				"/ip/address/;(evl /ip/address/print)",
			);
			expect(
				explainCommand(recovered, {}).structure.statements[2]?.command,
			).toMatchObject({ path: "/ip/address", verb: "print" });

			await recordIntegrationEvidence({
				suite: "explain-unlisted-nav",
				command: "explain",
				protocol: "rest-api",
				routerosVersion: started.chr.state.version,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [34],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);
});
