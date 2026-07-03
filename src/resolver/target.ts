/**
 * Target identity + credential resolution.
 *
 * Combines CDB identity (`./cdb.ts`), the settings precedence ladder
 * (`./settings.ts`), and the matched record's comment-kv `port` override into a
 * concrete transport target with per-field provenance. The result feeds
 * `EnvelopeTargetMeta` (`target.source` for the identity as a whole, plus the
 * `sources` map for each resolved field) and `meta.settings`.
 *
 * `via` selects the URL shape: `native-api` resolves to an `api://` /
 * `api-ssl://` base URL (TCP 8728 / TLS 8729), everything else to a REST
 * `http(s)://.../rest` base URL. MAC / ARP / MNDP identity fallback is out of
 * scope (WP-2c); the shape exposes `identity`/`recordIndex` and leaves room for
 * a future `mac` field.
 */

import { CentrsError } from "../errors.ts";
import type { RouterOsProtocol } from "../protocols/index.ts";
import { MAC_TELNET_PORT } from "../protocols/mac-telnet.ts";
import {
	NATIVE_API_PORT,
	NATIVE_API_TLS_PORT,
} from "../protocols/native-api.ts";
import type { CdbResolution } from "./cdb.ts";
import { normalizeMac } from "./mac.ts";
import {
	type ResolvedSetting,
	type ResolverSettingSource,
	resolveOptionalIntegerSetting,
	resolveStringSetting,
} from "./settings.ts";

const ENV_HOST = "CENTRS_HOST";
const ENV_PORT = "CENTRS_PORT";

export interface TargetResolveInput {
	targetInput?: string;
	host?: string;
	port?: number;
	/**
	 * Pre-resolved MAC→IP mapping (host ARP lookup). When the resolved host
	 * candidate is this MAC, `ip` is used as the transport host with `arp`
	 * provenance. The command resolution seam decides whether ARP is allowed.
	 */
	macResolution?: { mac: string; ip: string };
}

export interface ResolvedTarget {
	input?: string;
	host: string;
	port: number;
	scheme: "http" | "https";
	/** TLS transport (native-api over api-ssl). REST uses the URL scheme. */
	tls: boolean;
	baseUrl: string;
	/** Target MAC, set for L2 transports (mac-telnet) that address by MAC. */
	mac?: string;
	/** Human-facing device handle (CDB `identity=`, else target), if resolved. */
	identity?: string;
	recordIndex?: number;
	/** Provenance of the identity as a whole. */
	source: ResolverSettingSource;
	/** Provenance of the resolved host. */
	hostSource: ResolverSettingSource;
	/** Provenance of the resolved port (settings ladder). */
	portSource: ResolverSettingSource;
	/** Per-field provenance map for `EnvelopeTargetMeta.sources`. */
	sources: Record<string, ResolverSettingSource>;
}

export interface ResolvedAuth {
	username?: string;
	usernameSource?: ResolverSettingSource;
	password: string;
	passwordProvided: boolean;
	passwordSource?: ResolverSettingSource;
	/** SSH private-key path for sftp/scp/ssh; path only, never key material. */
	sshKey?: string;
	sshKeySource?: ResolverSettingSource;
}

export function resolveTarget(
	input: TargetResolveInput,
	env: Record<string, string | undefined>,
	via: RouterOsProtocol,
	cdb?: CdbResolution,
	config: Record<string, string | undefined> = {},
): ResolvedTarget {
	const hostSetting = resolveStringSetting(
		input.host,
		env,
		ENV_HOST,
		cdb?.target ?? input.targetInput,
		"host",
		undefined,
		undefined,
		config,
	);

	if (!hostSetting || hostSetting.value.trim().length === 0) {
		throw new CentrsError({
			code: "target/unresolved",
			summary: "No host could be resolved for `retrieve`.",
			remediation:
				"Pass a target positional like `centrs retrieve 192.0.2.10 /system/resource --via rest-api` or set `--host` / `CENTRS_HOST`.",
			context: { targetInput: input.targetInput },
		});
	}

	const rawCandidate = hostSetting.value.trim();
	const macCandidate = normalizeMac(rawCandidate);

	// L2 transports (mac-telnet) address the device by **MAC** directly — no IP
	// resolution. The MAC is the device identity (from the positional / CDB
	// target); the `host`/`port` are the *delivery* endpoint of the UDP/20561
	// datagrams (default L2 broadcast, overridable with `--host`/`--port` — the
	// integration harness points them at its loopback L2 bridge).
	if (via === "mac-telnet") {
		// The device MAC: an explicit MAC positional wins; otherwise the matched
		// CDB record's MAC (the `mac=` lookup key, or a MAC `target`) — so a device
		// resolved by identity=/ip= is still reachable over L2.
		const mac =
			normalizeMac(input.targetInput ?? "") ??
			cdb?.mac ??
			normalizeMac(cdb?.target ?? "");
		if (!mac) {
			throw new CentrsError({
				code: "target/mac-required",
				summary: `mac-telnet needs a MAC address target; got "${input.targetInput ?? cdb?.target ?? rawCandidate}".`,
				remediation:
					"Pass the device MAC (aa:bb:cc:dd:ee:ff), or pin an IP transport with `--via native-api`/`rest-api` (add `--resolve arp` for a MAC).",
				context: {
					target: input.targetInput ?? cdb?.target ?? rawCandidate,
					via,
				},
			});
		}
		const deliveryHostSetting = resolveStringSetting(
			input.host,
			env,
			ENV_HOST,
			undefined,
			"host",
			undefined,
			undefined,
			config,
		);
		const macPortSetting = resolveOptionalIntegerSetting(
			input.port,
			env,
			ENV_PORT,
			"port",
			cdb?.overrides.port,
			config,
		);
		// The device identity is the MAC (positional or CDB), NOT --host/CENTRS_HOST,
		// which are only the UDP delivery endpoint. Attribute meta.target.source to
		// where the MAC came from so an overridden delivery host does not masquerade
		// as the identity.
		const macSource: ResolverSettingSource = normalizeMac(
			input.targetInput ?? "",
		)
			? { kind: "target-input", key: input.targetInput as string }
			: cdb
				? { kind: "cdb", key: `record:${cdb.recordIndex}` }
				: hostSetting.source;
		// Delivery host/port provenance is independent of the identity.
		const deliverySource: ResolverSettingSource =
			deliveryHostSetting?.source ?? {
				kind: "default",
				key: "l2-broadcast",
			};
		const portSource: ResolverSettingSource = macPortSetting?.source ?? {
			kind: "default",
			key: "mac-telnet",
		};
		const deliveryHost = deliveryHostSetting?.value.trim() || "255.255.255.255";
		const port = macPortSetting?.value ?? MAC_TELNET_PORT;
		return {
			input: input.targetInput,
			host: deliveryHost,
			mac,
			port,
			scheme: "http",
			tls: false,
			baseUrl: `mac-telnet://${mac}`,
			identity: cdb?.identity,
			recordIndex: cdb?.recordIndex,
			source: macSource,
			hostSource: deliverySource,
			portSource,
			sources: {
				host: deliverySource,
				port: portSource,
			},
		};
	}

	let candidate = rawCandidate;
	let arpResolvedMac: string | undefined;
	if (macCandidate) {
		if (
			input.macResolution &&
			normalizeMac(input.macResolution.mac) === macCandidate
		) {
			candidate = input.macResolution.ip;
			arpResolvedMac = macCandidate;
		} else {
			// A MAC with no CDB record and no opted-in resolution. The command
			// seam normally throws first with operation-specific guidance; this
			// guards direct callers and never lets a MAC reach `new URL`.
			throw new CentrsError({
				code: "target/mac-unresolved",
				summary: `Target ${rawCandidate} is a MAC address that could not be resolved to a host.`,
				remediation:
					"Pass an IP/hostname, add a CDB record for this MAC, or opt into host ARP resolution with `--resolve arp`.",
				context: { mac: macCandidate },
			});
		}
	}
	const parsedUrl = parseHostCandidate(candidate);
	const portSetting = resolveOptionalIntegerSetting(
		input.port,
		env,
		ENV_PORT,
		"port",
		cdb?.overrides.port,
		config,
	);
	const scheme = parsedUrl.protocol === "https:" ? "https" : "http";

	const identitySource: ResolverSettingSource = arpResolvedMac
		? { kind: "arp", key: arpResolvedMac }
		: cdb && input.host === undefined && env[ENV_HOST] === undefined
			? { kind: "cdb", key: `record:${cdb.recordIndex}` }
			: hostSetting.source;

	const isNative = via === "native-api";
	const isSsh = via === "ssh";
	let port: number;
	let tls: boolean;
	let baseUrl: string;
	if (isSsh) {
		// SSH (sftp/scp/exec) addresses host:22 and carries its own crypto, so the
		// URL scheme is irrelevant. An explicit `--port` / URL port wins over 22.
		tls = false;
		port =
			portSetting?.value ??
			(parsedUrl.port.length > 0 ? Number.parseInt(parsedUrl.port, 10) : 22);
		baseUrl = `ssh://${formatHostForUrl(parsedUrl.hostname)}:${port}`;
	} else if (isNative) {
		// Native API ignores the URL scheme for its wire protocol; it defaults to
		// TCP 8728, or TLS (api-ssl) 8729 when the caller passed `https://` or an
		// explicit 8729. An explicit well-known port wins over the scheme so
		// `https://host --port 8728` stays plaintext instead of running a TLS
		// handshake against the plaintext API port.
		const explicitPort = portSetting?.value;
		if (explicitPort === NATIVE_API_PORT) {
			tls = false;
		} else if (explicitPort === NATIVE_API_TLS_PORT) {
			tls = true;
		} else {
			tls = scheme === "https";
		}
		port = explicitPort ?? (tls ? NATIVE_API_TLS_PORT : NATIVE_API_PORT);
		baseUrl = `${tls ? "api-ssl" : "api"}://${formatHostForUrl(parsedUrl.hostname)}:${port}`;
	} else {
		tls = scheme === "https";
		port = portSetting?.value ?? readPort(parsedUrl, scheme);
		baseUrl = `${scheme}://${formatHostForUrl(parsedUrl.hostname)}:${port}/rest`;
	}

	const portSource = resolvePortSource(
		portSetting,
		identitySource,
		port,
		scheme,
		isNative,
	);

	const sources: Record<string, ResolverSettingSource> = {
		host: identitySource,
		port: portSource,
	};

	return {
		input: input.targetInput,
		host: parsedUrl.hostname,
		port,
		scheme,
		tls,
		baseUrl,
		identity: cdb?.identity,
		recordIndex: cdb?.recordIndex,
		source: identitySource,
		hostSource: identitySource,
		portSource,
		sources,
	};
}

/**
 * Port provenance. When a port came from the settings ladder
 * (cli/env/comment-kv) its own source wins. Otherwise the port mirrors the
 * identity source, except a bare positional target on its scheme-default REST
 * port is attributed to the built-in default.
 */
function resolvePortSource(
	portSetting: ResolvedSetting<number> | undefined,
	identitySource: ResolverSettingSource,
	port: number,
	scheme: "http" | "https",
	isNative: boolean,
): ResolverSettingSource {
	if (portSetting) {
		return portSetting.source;
	}
	if (
		!isNative &&
		identitySource.kind === "target-input" &&
		port === defaultPortForScheme(scheme)
	) {
		return { kind: "default", key: `${scheme} default` };
	}
	return identitySource;
}

export function resolveAuth(
	credentials: { username?: string; password?: string; sshKey?: string },
	env: Record<string, string | undefined>,
	cdb?: CdbResolution,
	config: Record<string, string | undefined> = {},
): ResolvedAuth {
	// `CENTRS_USERNAME`/`CENTRS_PASSWORD` are deliberately NOT threaded through
	// the `config` tier: `settings` refuses to write either (constitution: the
	// `__default__` CDB record is the credential store), and the config-file
	// loader itself does not surface them even when hand-added to the file —
	// a stronger defense than read-time redaction alone, since a hand-edited
	// credential line in `centrs.env` then can't function as a live source.
	const username = resolveStringSetting(
		credentials.username,
		env,
		"CENTRS_USERNAME",
		undefined,
		"username",
	);
	// SSH key path: --ssh-key → CENTRS_SSH_KEY → CDB `ssh-key=` comment-kv →
	// config → unset. Path only; the SFTP/SSH transport reads the file, centrs
	// never stores material.
	const sshKey = resolveStringSetting(
		credentials.sshKey,
		env,
		"CENTRS_SSH_KEY",
		undefined,
		"ssh-key",
		undefined,
		cdb?.overrides.sshKey,
		config,
	);
	const password = resolveStringSetting(
		credentials.password,
		env,
		"CENTRS_PASSWORD",
		undefined,
		"password",
	);
	const def = cdb?.defaults;
	const cdbUsername =
		username === undefined && cdb?.username
			? {
					value: cdb.username,
					source: {
						kind: "cdb" as const,
						key: `record:${cdb.recordIndex}:user`,
					},
				}
			: undefined;
	const cdbPassword =
		password === undefined && cdb
			? {
					value: cdb.password,
					source: {
						kind: "cdb" as const,
						key: `record:${cdb.recordIndex}:password`,
					},
				}
			: undefined;
	// __default__ fallback: fill a field only when args/env and the matched
	// device record all left it unset. An empty device value is "unset".
	const defaultUsername =
		username === undefined &&
		cdbUsername === undefined &&
		def !== undefined &&
		def.username !== undefined
			? {
					value: def.username,
					source: {
						kind: "cdb" as const,
						key: `record:${def.recordIndex}:user`,
					},
				}
			: undefined;
	const defaultPassword =
		password === undefined &&
		def !== undefined &&
		def.password !== undefined &&
		(cdb?.password ?? "") === ""
			? {
					value: def.password,
					source: {
						kind: "cdb" as const,
						key: `record:${def.recordIndex}:password`,
					},
				}
			: undefined;
	const resolvedUsername = username ?? cdbUsername ?? defaultUsername;
	const resolvedPassword = password ?? defaultPassword ?? cdbPassword;

	return {
		username: resolvedUsername?.value,
		usernameSource: resolvedUsername?.source,
		password: resolvedPassword?.value ?? "",
		passwordProvided: resolvedPassword !== undefined,
		passwordSource: resolvedPassword?.source,
		sshKey: sshKey?.value,
		sshKeySource: sshKey?.source,
	};
}

export function parseHostCandidate(value: string): URL {
	if (/^https?:\/\//i.test(value)) {
		const url = new URL(value);
		if (url.pathname !== "/" && url.pathname !== "") {
			throw new CentrsError({
				code: "input/invalid-target",
				summary: `Target URL must not include a path. Received: ${value}`,
				remediation:
					"Pass only the RouterOS host or base URL, then provide the RouterOS menu path as the second positional argument.",
			});
		}
		return url;
	}

	return new URL(`http://${value}`);
}

function readPort(parsedUrl: URL, scheme: "http" | "https"): number {
	if (parsedUrl.port.length > 0) {
		return Number.parseInt(parsedUrl.port, 10);
	}
	return defaultPortForScheme(scheme);
}

export function defaultPortForScheme(scheme: "http" | "https"): number {
	return scheme === "https" ? 443 : 80;
}

function formatHostForUrl(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
