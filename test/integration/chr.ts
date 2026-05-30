import { appendFile } from "node:fs/promises";

type Channel = "stable" | "long-term" | "testing" | "development";

interface ChrInstance {
	name: string;
	state: { version: string };
	restUrl: string;
	subprocessEnv(): Promise<Record<string, string>>;
	destroy(): Promise<void>;
}

interface StartOptions {
	version?: string;
	channel?: Channel;
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

export async function startIntegrationChr(): Promise<StartedChr> {
	const requestedVersion = readEnv(Bun.env, "CENTRS_CHR_VERSION")?.trim();
	const requestedChannel = asChannel(readEnv(Bun.env, "CENTRS_CHR_CHANNEL"));
	const options: StartOptions = requestedVersion
		? { version: requestedVersion }
		: { channel: requestedChannel };
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
