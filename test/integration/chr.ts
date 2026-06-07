import { appendFile } from "node:fs/promises";

type Channel = "stable" | "long-term" | "testing" | "development";

/**
 * A quickchr network specifier (subset). `"user"` is the SLIRP management NIC;
 * `socket-connect` is the loopback L2 netdev whose every guest Ethernet frame
 * QEMU streams to a host TCP server — the path the MNDP/L2 integration tests use.
 */
export type ChrNetworkSpec =
	| "user"
	| { type: "socket-connect"; port: number }
	| { type: "socket-listen"; port: number }
	| { type: "socket-mcast"; group: string; port: number };

interface ChrInstance {
	name: string;
	state: { version: string };
	restUrl: string;
	ports: { api: number; apiSsl: number; [key: string]: number };
	subprocessEnv(): Promise<Record<string, string>>;
	destroy(): Promise<void>;
	/** Wait for the REST endpoint to answer; resolves true once booted. */
	waitForBoot(timeoutMs?: number): Promise<boolean>;
	/** Run a RouterOS console command (used here to set identity / discovery). */
	exec(command: string): Promise<unknown>;
	/** Issue a REST GET (the source-of-truth cross-check for L2-decoded values). */
	rest(path: string): Promise<unknown>;
	/** Stop and delete the machine (alias of destroy on newer quickchr). */
	remove(): Promise<void>;
}

interface StartOptions {
	version?: string;
	channel?: Channel;
	/** Override the generated machine name (L2 tests want a stable, unique name). */
	name?: string;
	/**
	 * Extra NICs beyond the default management network. The MNDP test boots
	 * `["user", { type: "socket-connect", port }]`: ether1 keeps REST/exec over
	 * SLIRP hostfwd, ether2 carries L2 broadcasts to the host bridge.
	 */
	networks?: readonly ChrNetworkSpec[];
}

const routerOsChannels = [
	"stable",
	"long-term",
	"testing",
	"development",
] as const satisfies readonly Channel[];

export function readEnv(
	record: Record<string, string | undefined>,
	key: string,
): string | undefined {
	return record[key];
}

export function isChrIntegrationEnabled(): boolean {
	return readEnv(Bun.env, "CENTRS_RUN_FAST_INTEGRATION") === "1";
}

export function exampleIds(count: number): number[] {
	return Array.from({ length: count }, (_, index) => index + 1);
}

function asChannel(value: string | undefined): Channel {
	if (routerOsChannels.some((channel) => channel === value)) {
		return value as Channel;
	}
	return "stable";
}

export function splitQuickChrAuth(raw: string): {
	username: string;
	password: string;
} {
	const separator = raw.indexOf(":");
	if (separator === -1) {
		return {
			username: raw,
			password: "",
		};
	}

	return {
		username: raw.slice(0, separator),
		password: raw.slice(separator + 1),
	};
}

export interface StartedChr {
	chr: ChrInstance;
	env: Record<string, string>;
	requestedChannel?: Channel;
	requestedVersion?: string;
}

export async function startIntegrationChr(
	extra: Partial<StartOptions> = {},
): Promise<StartedChr> {
	const requestedVersion = readEnv(Bun.env, "CENTRS_CHR_VERSION")?.trim();
	const requestedChannel = asChannel(readEnv(Bun.env, "CENTRS_CHR_CHANNEL"));
	const options: StartOptions = {
		...(requestedVersion
			? { version: requestedVersion }
			: { channel: requestedChannel }),
		...extra,
	};
	const moduleName = "@tikoci/quickchr";
	const quickChrModule = (await import(moduleName)) as unknown as {
		QuickCHR: {
			start(options: StartOptions): Promise<ChrInstance>;
		};
	};
	const chr = await quickChrModule.QuickCHR.start(options);
	const env = await chr.subprocessEnv();

	return {
		chr,
		env,
		requestedChannel: requestedVersion ? undefined : requestedChannel,
		requestedVersion: requestedVersion || undefined,
	};
}

export interface IntegrationEvidence {
	suite: string;
	command: string;
	protocol: string;
	routerosVersion: string;
	boardName?: string;
	quickChrName?: string;
	requestedChannel?: string;
	requestedVersion?: string;
	exampleIds: readonly number[];
}

export async function recordIntegrationEvidence(
	evidence: IntegrationEvidence,
): Promise<void> {
	const timestamp = new Date().toISOString();
	const record = {
		...evidence,
		timestamp,
	};
	const jsonLine = `${JSON.stringify(record)}\n`;
	const reportPath = readEnv(Bun.env, "CENTRS_INTEGRATION_REPORT");
	if (reportPath) {
		await appendFile(reportPath, jsonLine, "utf8");
	}

	const summaryPath = readEnv(Bun.env, "GITHUB_STEP_SUMMARY");
	if (!summaryPath) return;

	const requested = evidence.requestedVersion
		? `version ${evidence.requestedVersion}`
		: `channel ${evidence.requestedChannel ?? "stable"}`;
	const board = evidence.boardName ?? "";
	const examples = evidence.exampleIds.join(", ");
	await appendFile(
		summaryPath,
		[
			"### centrs CHR integration evidence",
			"",
			"| Suite | Command | Protocol | Requested | RouterOS | Board | Examples |",
			"| --- | --- | --- | --- | --- | --- | --- |",
			`| ${evidence.suite} | ${evidence.command} | ${evidence.protocol} | ${requested} | ${evidence.routerosVersion} | ${board} | ${examples} |`,
			"",
		].join("\n"),
		"utf8",
	);
}
