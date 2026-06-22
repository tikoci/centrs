import { appendFile } from "node:fs/promises";

type Channel = "stable" | "long-term" | "testing" | "development";

/**
 * Guest architecture quickchr can boot (subset of its `Arch`). Default is the
 * host arch; `CENTRS_CHR_ARCH=arm64` forces an aarch64 CHR. NOTE: as of quickchr
 * 0.4.2 an arm64 CHR has a REST-POST bug (a `restPost` to `/rest/execute` returns
 * the prior `restGet`'s body — quickchr BACKLOG, P3), which breaks centrs's
 * execute path, so no arm64 integration job is wired yet — the plumbing here just
 * makes centrs ready for the day that lands. x86 is the validated path.
 */
type Arch = "arm64" | "x86";

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

/**
 * A host→guest port forward (quickchr `extraPorts` / `PortMapping`). The btest
 * client test boots with `{ name: "btest", host: 0, guest: 2000, proto: "tcp" }`
 * so a host TCP port (auto-allocated when `host: 0`) maps onto the guest's
 * `/tool/bandwidth-server` on 2000 — the host→guest mapping a direct
 * centrs-client → CHR-server test needs (a `user`/SLIRP guest is otherwise
 * unreachable from the host). The host port surfaces on the instance as
 * `chr.ports[name]`.
 */
export interface ChrPortForward {
	name: string;
	host: number;
	guest: number;
	proto: "tcp" | "udp";
}

interface ChrInstance {
	name: string;
	state: { version: string };
	restUrl: string;
	ports: { api: number; apiSsl: number; [key: string]: number };
	/** Host port forwarded to the guest's SSH (TCP/22) over the SLIRP NIC. */
	sshPort: number;
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
	/** Guest architecture. Omitted = host arch (x86 on the maintainer's Intel Mac). */
	arch?: Arch;
	/**
	 * Extra RouterOS packages to install after boot (quickchr provisioning, e.g.
	 * `["container"]`). Lets the release/extended sweep validate centrs against a
	 * fuller RouterOS than the bare CHR image.
	 */
	packages?: string[];
	/** Override the generated machine name (L2 tests want a stable, unique name). */
	name?: string;
	/**
	 * Extra NICs beyond the default management network. The MNDP test boots
	 * `["user", { type: "socket-connect", port }]`: ether1 keeps REST/exec over
	 * SLIRP hostfwd, ether2 carries L2 broadcasts to the host bridge.
	 */
	networks?: readonly ChrNetworkSpec[];
	/**
	 * Extra host→guest port forwards beyond the management mappings. The btest
	 * client test forwards a host TCP port onto guest 2000 ({@link ChrPortForward}).
	 */
	extraPorts?: readonly ChrPortForward[];
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

/**
 * RouterOS classifies a *validation reject* differently across versions. For an
 * unknown attribute (e.g. `no-such-arg=x`), the RouterOS `:parse` output differs:
 *   - ≥ 7.23 reports `bad parameter <name>` → centrs `validation/unknown-attribute`
 *   - ≤ 7.21.x reports a generic `syntax error (line/col)` → centrs `validation/syntax`
 * centrs cannot tell "unknown attribute" from "syntax error" on the older wording,
 * so both are correct "validation rejected, nothing ran" outcomes. Integration
 * tests assert the reject is one of these, not the exact sub-code.
 * (JG-14: surfaced by the 7.21.4 long-term CHR run.)
 */
export const VALIDATION_REJECT_CODES: readonly string[] = [
	"validation/unknown-attribute",
	"validation/syntax",
];

/**
 * Compare two RouterOS version strings (e.g. "7.21.4 (long-term) ...", "7.23",
 * "7.23beta2"). Returns true when `running` ≥ `target`, ordering on
 * major.minor.patch, then prerelease stage (beta < rc < release), then the stage
 * number — so 7.23beta1 < 7.23beta2 < 7.23rc1 < 7.23 < 7.23.1. Used to
 * version-gate features that only exist on newer RouterOS — e.g. the `/file/copy`
 * REST endpoint, first seen in 7.23beta2 (so a 7.23beta1 testing build must gate
 * out). A release with no suffix sorts above any beta/rc of the same x.y.
 */
export function routerOsAtLeast(running: string, target: string): boolean {
	const parts = (raw: string): [number, number, number, number, number] => {
		const match = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?(?:(beta|rc)(\d+))?/i);
		if (!match) {
			return [0, 0, 0, 2, 0];
		}
		// Stage rank: release (no beta/rc) sorts above rc, which sorts above beta.
		const stage = match[4]?.toLowerCase();
		const stageRank = stage === undefined ? 2 : stage === "rc" ? 1 : 0;
		return [
			Number(match[1]),
			Number(match[2]),
			Number(match[3] ?? 0),
			stageRank,
			Number(match[5] ?? 0),
		];
	};
	const a = parts(running);
	const b = parts(target);
	for (let index = 0; index < a.length; index += 1) {
		const left = a[index] ?? 0;
		const right = b[index] ?? 0;
		if (left !== right) {
			return left > right;
		}
	}
	return true;
}

function asChannel(value: string | undefined): Channel {
	if (routerOsChannels.some((channel) => channel === value)) {
		return value as Channel;
	}
	return "stable";
}

const routerOsArches = ["arm64", "x86"] as const satisfies readonly Arch[];

/** `CENTRS_CHR_ARCH` → a known arch, or undefined to let quickchr pick the host arch. */
export function asArch(value: string | undefined): Arch | undefined {
	return routerOsArches.find((arch) => arch === value?.trim());
}

/** `CENTRS_CHR_PACKAGES` (comma/whitespace-separated) → a clean package list. */
export function parsePackages(value: string | undefined): string[] {
	if (!value) {
		return [];
	}
	return value
		.split(/[\s,]+/)
		.map((pkg) => pkg.trim())
		.filter(Boolean);
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
	/** The arch quickchr was asked to boot, when `CENTRS_CHR_ARCH` pinned one. */
	requestedArch?: Arch;
}

export async function startIntegrationChr(
	extra: Partial<StartOptions> = {},
): Promise<StartedChr> {
	const requestedVersion = readEnv(Bun.env, "CENTRS_CHR_VERSION")?.trim();
	const requestedChannel = asChannel(readEnv(Bun.env, "CENTRS_CHR_CHANNEL"));
	const requestedArch = asArch(readEnv(Bun.env, "CENTRS_CHR_ARCH"));
	const requestedPackages = parsePackages(
		readEnv(Bun.env, "CENTRS_CHR_PACKAGES"),
	);
	const options: StartOptions = {
		...(requestedVersion
			? { version: requestedVersion }
			: { channel: requestedChannel }),
		// Env supplies defaults; an explicit `extra` (a test's own boot options) wins.
		...(requestedArch ? { arch: requestedArch } : {}),
		...(requestedPackages.length > 0 ? { packages: requestedPackages } : {}),
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
		requestedArch: options.arch,
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
