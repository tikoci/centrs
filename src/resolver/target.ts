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

import { isIP } from "node:net";
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
			context: { targetInput: redactTargetInput(input.targetInput) },
		});
	}

	const rawCandidate = hostSetting.value.trim();
	assertNoTargetCredentials(rawCandidate);
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
				summary: `mac-telnet needs a MAC address target; got "${redactTargetInput(input.targetInput ?? cdb?.target ?? rawCandidate)}".`,
				remediation:
					"Pass the device MAC (aa:bb:cc:dd:ee:ff), or pin an IP transport with `--via native-api`/`rest-api` (add `--resolve arp` for a MAC).",
				context: {
					target: redactTargetInput(
						input.targetInput ?? cdb?.target ?? rawCandidate,
					),
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
			input: redactTargetInput(input.targetInput),
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
		port = portSetting?.value ?? typedPort(candidate, parsedUrl) ?? 22;
		baseUrl = `ssh://${formatHostForUrl(parsedUrl.hostname)}:${port}`;
	} else if (isNative) {
		// Native API ignores the URL scheme for its wire protocol; it defaults to
		// TCP 8728, or TLS (api-ssl) 8729 when the caller passed `https://` or an
		// explicit 8729. An explicit well-known port wins over the scheme so
		// `https://host --port 8728` stays plaintext instead of running a TLS
		// handshake against the plaintext API port. A port the caller typed in
		// the host (`host:9`, `http://host:9`) counts as explicit, as it does for
		// ssh and REST (#426); a matched CDB record's port may be WinBox's, so it
		// is left alone.
		const explicitPort =
			portSetting?.value ??
			(hostFromCdbRecord(hostSetting, cdb)
				? undefined
				: typedPort(candidate, parsedUrl));
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
		input: redactTargetInput(input.targetInput),
		// WHATWG keeps an IPv6 hostname bracketed; sockets and ssh need the bare
		// address (`baseUrl` re-brackets it).
		host: parsedUrl.hostname.replace(/^\[(.*)\]$/, "$1"),
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
 * The port written in the host candidate, if any. WHATWG `URL` drops a
 * scheme-default port (`http://h:80`, `https://h:443`, and a bare `h:80`, which
 * parses as http), so an empty `URL.port` is re-read from the text. The URL has
 * already parsed, so a trailing `:digits` can only be that port, except in a
 * bare IPv6 literal (`2001:db8::1`), which carries no port.
 */
function typedPort(candidate: string, parsedUrl: URL): number | undefined {
	if (parsedUrl.port.length > 0) {
		return Number.parseInt(parsedUrl.port, 10);
	}
	if (isIP(candidate) === 6) {
		return undefined;
	}
	const authority = candidate.replace(/^https?:\/\//i, "").replace(/\/$/, "");
	const match = /:(\d+)$/.exec(authority);
	return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : undefined;
}

/**
 * True when the host is a matched CDB record's `target` rather than something
 * the caller typed (`--host`, `CENTRS_HOST`, config, or the positional itself).
 * A `__default__`-only resolution carries the positional as its target, so its
 * record index is the default record's.
 */
function hostFromCdbRecord(
	hostSetting: ResolvedSetting<string>,
	cdb: CdbResolution | undefined,
): boolean {
	return (
		cdb !== undefined &&
		hostSetting.source.kind === "target-input" &&
		cdb.recordIndex !== cdb.defaults?.recordIndex
	);
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

/** An authority with userinfo: `user@host`, `user:pass@host`, with or without a scheme. */
const URL_USERINFO = /^\s*([a-z][a-z0-9+.-]*:\/\/)?[^/@\s]*@/i;
/** Leading whitespace and an optional `scheme://`, kept by redaction. */
const TARGET_PREFIX = /^\s*(?:[a-z][a-z0-9+.-]*:\/\/)?/i;

/**
 * Where credentials could sit: a `:` before the LAST `@`, or explicit URL
 * userinfo. Display also masks a percent-encoded colon; lookup validation
 * allows that ambiguous spelling until CDB lookup has run. Bare `user@host`
 * remains a CDB identity candidate. Index arithmetic, so a password holding `/`, `?` or
 * `#` (which ends a URL authority early, CodeRabbit on PR #479) still counts,
 * and nothing can backtrack (CodeQL js/polynomial-redos).
 */
function targetCredentialsSpan(
	value: string,
	includeEncodedColon = true,
): { start: number; at: number } | undefined {
	const at = value.lastIndexOf("@");
	if (at < 0) return undefined;
	const prefix = TARGET_PREFIX.exec(value)?.[0] ?? "";
	const start = prefix.length;
	const urlUserinfo = prefix.includes("://") && URL_USERINFO.test(value);
	const userinfo = value.slice(start, at);
	return userinfo.includes(":") ||
		(includeEncodedColon && /%3a/i.test(userinfo)) ||
		urlUserinfo
		? { start, at }
		: undefined;
}

/**
 * A target string with any `user:pass@` or explicit URL userinfo replaced by
 * `***@`, for display (#478).
 * A target is echoed in `meta.target.input` and in error messages, so the
 * password part must never reach them, not even when the target is refused.
 * Everything up to the last `@` goes, so an odd password cannot slip past.
 * Other targets, including a CDB identity like `rtr@site`, pass unchanged.
 * An encoded colon is masked conservatively without changing lookup input.
 */
export function redactTargetInput(value: string): string;
export function redactTargetInput(
	value: string | undefined,
): string | undefined;
export function redactTargetInput(
	value: string | undefined,
): string | undefined {
	if (value === undefined) return value;
	const span = targetCredentialsSpan(value);
	return span
		? `${value.slice(0, span.start)}***${value.slice(span.at)}`
		: value;
}

function targetCredentialsError(value: string): CentrsError {
	const target = redactTargetInput(value);
	return new CentrsError({
		code: "input/invalid-target",
		summary: `A target must not carry credentials (\`user[:password]@\`): ${target}`,
		remediation:
			"Drop the `user:password@` part and pass the credentials with `--username` and `--password` (or `CENTRS_USERNAME`/`CENTRS_PASSWORD`, or a CDB record); give the target as `host[:port]` or `http(s)://host[:port]`.",
		context: { target },
	});
}

/**
 * Refuse a target that may hold a password, BEFORE any lookup whose miss would
 * echo it (#478): `resolveCdb`, the MCP allowlist, the fan-out selection. A
 * bare `user@host` is left to the lookup; a CDB identity may contain `@`.
 * Explicit URL userinfo is always refused, including percent-encoded forms.
 */
export function assertNoTargetPassword(value: string): void {
	if (targetCredentialsSpan(value, false)) throw targetCredentialsError(value);
}

/**
 * centrs never reads credentials from a target (#478): `user:pass@host` used
 * to be accepted with its credentials ignored, and echoed the password back.
 * After lookup, refuse any userinfo in the host to dial, from any source.
 */
export function assertNoTargetCredentials(value: string): void {
	if (targetCredentialsSpan(value) || URL_USERINFO.test(value)) {
		throw targetCredentialsError(value);
	}
}

export function parseHostCandidate(value: string): URL {
	const hasScheme = /^https?:\/\//i.test(value);
	// A bare IPv6 literal (`2001:db8::1`) has no port; URL needs it bracketed.
	const authority = isIP(value) === 6 ? `[${value}]` : value;
	let url: URL;
	try {
		url = new URL(hasScheme ? value : `http://${authority}`);
	} catch (cause) {
		throw invalidTargetError(value, cause);
	}
	if (hasScheme && url.pathname !== "/" && url.pathname !== "") {
		throw new CentrsError({
			code: "input/invalid-target",
			summary: `Target URL must not include a path. Received: ${redactTargetInput(value)}`,
			remediation:
				"Pass only the RouterOS host or base URL, then provide the RouterOS menu path as the second positional argument.",
		});
	}
	return url;
}

/**
 * A `<router>` that is not a CDB handle and does not parse as a host (#381).
 * `quickchr:NAME` is the likely guess for a quickchr VM, so it names the flag.
 */
function invalidTargetError(value: string, cause: unknown): CentrsError {
	const quickchrGuess = /^quickchr:(.+)$/i.exec(value)?.[1];
	return new CentrsError({
		code: "input/invalid-target",
		summary: `Target is not a known device or a valid host: ${redactTargetInput(value)}`,
		remediation:
			quickchrGuess !== undefined
				? `Select a quickchr VM with the flag: \`--quickchr ${quickchrGuess}\` (there is no \`quickchr:\` target prefix).`
				: "Pass a CDB target or identity (see `centrs devices list`), an IP or hostname with optional `:port`, or an `http(s)://host[:port]` base URL.",
		context: { target: redactTargetInput(value) },
		cause,
	});
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

export function formatHostForUrl(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
