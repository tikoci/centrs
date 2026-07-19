/**
 * The quickchr named-live-provider (#134): resolve `--quickchr <name>` into the
 * neutral per-service connection facts (`./service-endpoint.ts`).
 *
 * quickchr is a *named-live-provider* (see `docs/CONSTITUTION.md` → Resolution
 * providers), not a selector-source: it is addressed only by an explicit flag,
 * never matched by `--group`/`--where`, and it owns an ephemeral endpoint. This
 * module produces the {@link ServiceEndpointMap} for a running machine and maps
 * quickchr's typed failures onto centrs' `quickchr/*` errors. Selection, fan-out,
 * `--via` choice, and the settings/`__default__` bypass live with the CLI plumbing
 * (#134 Phase 3+); this file is only the connection-fact origin.
 *
 * Boundaries (`tikoci/quickchr` `docs/centrs-interface.md`):
 *   - quickchr is imported through a **runtime specifier** (as in
 *     `scripts/qa-active-channels.ts` / `test/integration/chr.ts`), so the
 *     optional dependency's raw `.ts` never enters centrs' strict `tsc`, and a
 *     missing package is a friendly typed error rather than a build/import crash.
 *   - centrs reads quickchr's public API only (`QuickCHR.get(name).descriptor()`);
 *     it never touches `machine.json`, `quickchr.env`, or the credential store.
 *   - The descriptor is credential-bearing; its `auth` values are secret material
 *     and must never be logged.
 */

import { CentrsError } from "../errors.ts";
import { plannedProtocols, type RouterOsProtocol } from "../protocols/index.ts";
import type {
	AnyServiceEndpoint,
	ServiceEndpointMap,
	SshEndpointAuth,
} from "./service-endpoint.ts";
import { isEndpointAvailable } from "./service-endpoint.ts";
import type { ResolvedAuth, ResolvedTarget } from "./target.ts";
import { formatHostForUrl } from "./target.ts";

/** Highest quickchr descriptor schema version this centrs understands. */
export const SUPPORTED_DESCRIPTOR_VERSION = 1;

const QUICKCHR_MODULE = "@tikoci/quickchr";

/**
 * The narrow slice of quickchr's public API this consumer depends on. Declared
 * here (not imported) so the runtime-specifier `import()` keeps quickchr's types
 * out of `tsc`; the shapes mirror `@tikoci/quickchr` `docs/centrs-interface.md`.
 */
interface QuickChrInstance {
	// The descriptor crosses an optional-dependency boundary, so it is `unknown`
	// until validated by `validateDescriptor()` — never trust its runtime shape.
	descriptor(): Promise<unknown>;
}

interface QuickChrModule {
	QuickCHR?: {
		get?(name: string): QuickChrInstance | null | undefined;
	};
}

/** The descriptor fields centrs reads. quickchr's `ServiceEndpoint` is structurally
 *  identical to centrs' neutral {@link AnyServiceEndpoint} (deliberately shared). */
interface QuickchrDescriptor {
	descriptorVersion: number;
	quickchr?: { packageVersion?: string };
	name: string;
	version: string;
	arch: string;
	services: Record<string, AnyServiceEndpoint>;
}

/** A quickchr error carries a typed `code` (`ErrorCode`) we can branch on. */
function quickchrErrorCode(error: unknown): string | undefined {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof (error as { code: unknown }).code === "string"
	) {
		return (error as { code: string }).code;
	}
	return undefined;
}

/** Resolved quickchr connection facts for one running machine. */
export interface QuickchrResolution {
	/** The machine name quickchr reports (echoes the `--quickchr <name>` input). */
	name: string;
	/** Per-`--via` endpoints; only protocols quickchr forwards are present. */
	services: ServiceEndpointMap;
	/** The descriptor schema version quickchr emitted (≤ {@link SUPPORTED_DESCRIPTOR_VERSION}). */
	descriptorVersion: number;
	/** The `@tikoci/quickchr` package version that produced the descriptor, when reported. */
	packageVersion?: string;
	/** The RouterOS version the CHR is running. */
	routerOsVersion: string;
	/** The CHR architecture (e.g. `x86_64`). */
	arch: string;
}

async function loadQuickChr(): Promise<QuickChrModule> {
	return (await import(QUICKCHR_MODULE)) as unknown as QuickChrModule;
}

function packageUnavailable(cause: unknown): CentrsError {
	return new CentrsError({
		code: "quickchr/package-unavailable",
		summary: `The optional \`${QUICKCHR_MODULE}\` package is required for \`--quickchr\` targets but is not installed.`,
		remediation: `Install it with \`bun add ${QUICKCHR_MODULE}\` (it is an optional dependency), or target the device directly with \`--host\`/a CDB record instead of \`--quickchr\`.`,
		context: { module: QUICKCHR_MODULE },
		cause,
	});
}

/** A `quickchr/unsupported` for an old/malformed descriptor the provider can't trust. */
function malformedDescriptor(
	name: string,
	detail: string,
	extra?: { context?: Record<string, unknown>; cause?: unknown },
): CentrsError {
	return new CentrsError({
		code: "quickchr/unsupported",
		summary: `quickchr described machine "${name}" with a descriptor centrs cannot use: ${detail}.`,
		remediation: `Upgrade to a \`${QUICKCHR_MODULE}\` release that emits descriptor v${SUPPORTED_DESCRIPTOR_VERSION} (0.4.5+); check the machine with \`quickchr inspect ${name}\`.`,
		context: { module: QUICKCHR_MODULE, machine: name, ...extra?.context },
		cause: extra?.cause,
	});
}

/**
 * Distinguish a *missing* optional package from one that is installed but failed
 * to evaluate. Only a failure to resolve `@tikoci/quickchr` **itself** is
 * `quickchr/package-unavailable`; an installed quickchr whose own transitive
 * import is missing carries the same `ERR_MODULE_NOT_FOUND` code but names a
 * different specifier — that is a real load fault (→ `quickchr/unsupported`,
 * cause preserved), not a missing optional dep. Mislabeling it would send the
 * user to reinstall the wrong package.
 */
function isModuleNotFound(cause: unknown): boolean {
	const message = cause instanceof Error ? cause.message : String(cause);
	// The loader quotes the specifier it could not resolve, e.g.
	// `Cannot find module '@tikoci/quickchr'` (top-level, missing) vs
	// `Cannot find package 'left-pad' imported from …/@tikoci/quickchr/…` (transitive).
	const missing = message.match(
		/cannot find (?:module|package)\s+['"]([^'"]+)['"]/i,
	)?.[1];
	if (missing !== undefined) {
		return missing === QUICKCHR_MODULE;
	}
	// No parseable specifier: fall back to the not-found code, but only when the
	// message references our module and not a nested (`imported from`) resolution.
	const code = quickchrErrorCode(cause);
	const isNotFoundCode =
		code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
	return (
		isNotFoundCode &&
		message.includes(QUICKCHR_MODULE) &&
		!/imported from|from\s+['"]/i.test(message)
	);
}

/**
 * Validate the untrusted descriptor an optional-dependency call returned into the
 * shape centrs reads. Every malformed/old/newer case becomes an actionable
 * `quickchr/unsupported` — never a raw `TypeError` from a later field access, and
 * never a silent empty `services` map (that would hide a provider contract
 * violation and defer the failure to a `--via` lookup).
 */
function validateDescriptor(raw: unknown, name: string): QuickchrDescriptor {
	if (typeof raw !== "object" || raw === null) {
		throw malformedDescriptor(
			name,
			"quickchr returned a non-object descriptor",
		);
	}
	const d = raw as Partial<QuickchrDescriptor>;
	if (typeof d.descriptorVersion !== "number") {
		throw malformedDescriptor(
			name,
			"it has no numeric `descriptorVersion` (pre-v1 or malformed)",
		);
	}
	if (d.descriptorVersion > SUPPORTED_DESCRIPTOR_VERSION) {
		throw new CentrsError({
			code: "quickchr/unsupported",
			summary: `quickchr emitted descriptor v${d.descriptorVersion}, but this centrs understands only v${SUPPORTED_DESCRIPTOR_VERSION}.`,
			remediation:
				"Upgrade centrs to a release that supports the newer quickchr descriptor version.",
			context: {
				machine: name,
				descriptorVersion: d.descriptorVersion,
				supported: SUPPORTED_DESCRIPTOR_VERSION,
			},
		});
	}
	if (typeof d.services !== "object" || d.services === null) {
		throw malformedDescriptor(
			name,
			"it has no `services` map (the quickchr contract requires one)",
		);
	}
	if (
		typeof d.name !== "string" ||
		typeof d.version !== "string" ||
		typeof d.arch !== "string"
	) {
		throw malformedDescriptor(
			name,
			"it is missing required `name`/`version`/`arch` fields",
		);
	}
	return d as QuickchrDescriptor;
}

/**
 * Map quickchr's `services` map onto the neutral {@link ServiceEndpointMap}. Only
 * keys that are known centrs `--via` protocols are carried; unknown future service
 * keys are ignored (the descriptor's additive-only forward-compat policy). The
 * endpoint objects are structurally centrs' own shape, so no per-field rewrite is
 * needed here — provider-specific auth mapping (e.g. `privateKeyPath` → `sshKey`)
 * happens later when an endpoint is turned into a `ResolvedAuth` for a chosen `--via`.
 */
function mapServices(
	services: Record<string, AnyServiceEndpoint>,
): ServiceEndpointMap {
	const map: ServiceEndpointMap = {};
	const known = new Set<string>(plannedProtocols);
	for (const [key, endpoint] of Object.entries(services)) {
		if (known.has(key)) {
			// The per-key map narrows `ssh` to SshServiceEndpoint; the provider-supplied
			// endpoint is structurally correct per the descriptor contract, so assign
			// through a widened view rather than re-validating each field here.
			(map as Record<RouterOsProtocol, AnyServiceEndpoint>)[
				key as RouterOsProtocol
			] = endpoint;
		}
	}
	return map;
}

/**
 * Resolve a `--quickchr <name>` target into its live connection facts. Throws a
 * typed `quickchr/*` error for every failure mode — a missing package, an
 * unsupported/old quickchr, an unknown machine name, or a stopped machine — never
 * a silent fallback. The `load` seam is for unit tests; production passes nothing.
 */
export async function resolveQuickchrTarget(
	name: string,
	load: () => Promise<QuickChrModule> = loadQuickChr,
): Promise<QuickchrResolution> {
	let mod: QuickChrModule;
	try {
		mod = await load();
	} catch (cause) {
		// A CentrsError from the loader (or downstream) passes through unchanged.
		if (cause instanceof CentrsError) {
			throw cause;
		}
		// Only a genuine module-not-found is "package not installed"; an installed
		// package that throws while loading is a real fault, not a missing optional dep.
		if (isModuleNotFound(cause)) {
			throw packageUnavailable(cause);
		}
		throw new CentrsError({
			code: "quickchr/unsupported",
			summary: `The \`${QUICKCHR_MODULE}\` package is installed but failed to load.`,
			remediation: `Reinstall it (\`bun add ${QUICKCHR_MODULE}\`) or inspect the underlying load error; target the device with \`--host\`/a CDB record to bypass \`--quickchr\`.`,
			context: { module: QUICKCHR_MODULE },
			cause,
		});
	}
	if (typeof mod?.QuickCHR?.get !== "function") {
		throw new CentrsError({
			code: "quickchr/unsupported",
			summary: `The installed \`${QUICKCHR_MODULE}\` does not expose the \`QuickCHR.get()\` descriptor API centrs needs.`,
			remediation: `Upgrade to a \`${QUICKCHR_MODULE}\` release that ships descriptor v${SUPPORTED_DESCRIPTOR_VERSION} (0.4.5+).`,
			context: { module: QUICKCHR_MODULE },
		});
	}

	const instance = mod.QuickCHR.get(name);
	if (instance === null || instance === undefined) {
		throw new CentrsError({
			code: "quickchr/machine-not-found",
			summary: `No quickchr machine named "${name}" is registered.`,
			remediation:
				"List machines with `quickchr list` and pass an existing name, or start it with `quickchr start`.",
			context: { machine: name },
		});
	}

	let raw: unknown;
	try {
		raw = await instance.descriptor();
	} catch (cause) {
		const code = quickchrErrorCode(cause);
		if (code === "MACHINE_STOPPED") {
			throw new CentrsError({
				code: "quickchr/machine-stopped",
				summary: `The quickchr machine "${name}" is not running, so it has no live connection facts.`,
				remediation: `Start it with \`quickchr start ${name}\` (or by name), then retry \`--quickchr ${name}\`.`,
				context: { machine: name },
				cause,
			});
		}
		if (code === "MACHINE_NOT_FOUND") {
			throw new CentrsError({
				code: "quickchr/machine-not-found",
				summary: `No quickchr machine named "${name}" is registered.`,
				remediation:
					"List machines with `quickchr list` and pass an existing name, or start it with `quickchr start`.",
				context: { machine: name },
				cause,
			});
		}
		throw new CentrsError({
			code: "quickchr/unsupported",
			summary: `quickchr failed to describe machine "${name}".`,
			remediation:
				"Check `quickchr inspect <name>` directly; the machine may be in a transient state.",
			context: { machine: name, quickchrCode: code },
			cause,
		});
	}

	const descriptor = validateDescriptor(raw, name);

	return {
		name: descriptor.name,
		services: mapServices(descriptor.services),
		descriptorVersion: descriptor.descriptorVersion,
		packageVersion: descriptor.quickchr?.packageVersion,
		routerOsVersion: descriptor.version,
		arch: descriptor.arch,
	};
}

/**
 * The `--quickchr` ↔ direct-override conflict (#134 "Initial override rule"):
 * a named-live-provider owns its ephemeral endpoint, so explicit `--host` /
 * `--port` / `--username` / `--password` / `--ssh-key` values have nothing to
 * override and are rejected up front rather than silently ignored. Env/config
 * values for the same fields are NOT a conflict — the provider simply bypasses
 * the settings ladder for connection facts (`docs/CONSTITUTION.md` →
 * Resolution providers).
 */
export function assertNoQuickchrOverrideConflict(
	request: {
		host?: string;
		port?: number;
		username?: string;
		password?: string;
		sshKey?: string;
	},
	machine: string,
): void {
	const conflicts: string[] = [];
	if (request.host !== undefined) {
		conflicts.push("--host");
	}
	if (request.port !== undefined) {
		conflicts.push("--port");
	}
	if (request.username !== undefined) {
		conflicts.push("--username");
	}
	if (request.password !== undefined) {
		conflicts.push("--password");
	}
	if (request.sshKey !== undefined) {
		conflicts.push("--ssh-key");
	}
	if (conflicts.length === 0) {
		return;
	}
	throw new CentrsError({
		code: "usage/conflicting-flags",
		summary: `\`--quickchr ${machine}\` supplies host/port/auth from the live VM descriptor and cannot be combined with ${conflicts.join(", ")}.`,
		remediation:
			"Drop the override flag(s) and let quickchr supply the connection facts, or drop `--quickchr` and target the device directly.",
		context: { machine, conflicts },
	});
}

/** The connection facts a chosen `--via` extracts from a quickchr resolution. */
export interface QuickchrConnection {
	target: ResolvedTarget;
	auth: ResolvedAuth;
	/**
	 * True when centrs must relax peer verification to use the endpoint: the
	 * descriptor prefers the VM's TLS forwards (https / api-ssl), whose
	 * certificate is the CHR's own self-signed one, and an SSH endpoint's host
	 * key is ephemeral (regenerated per VM). The endpoint is trusted **by
	 * provenance** — quickchr vouches for its loopback-forwarded port — so the
	 * command resolver applies `insecure` with `provider` provenance and surfaces
	 * {@link warnings} rather than demanding `--insecure` for every lab call.
	 */
	insecure: boolean;
	/** Envelope warnings the consuming resolver must carry (provider-trust note). */
	warnings: readonly { code: string; message: string }[];
}

/**
 * True when the SSH endpoint's advertised auth can actually complete a batch
 * (non-interactive) handoff: `agent-or-config`, or `private-key` **with** a
 * `privateKeyPath` to hand to the client. A bare `private-key` batch mode with
 * no path would silently fall back to whatever ambient agent/config offers —
 * an unintended trust widening — so it does not count as usable.
 */
function hasUsableSshAuth(auth: SshEndpointAuth | undefined): boolean {
	const batchModes = auth?.batchModes ?? [];
	return (
		batchModes.includes("agent-or-config") ||
		(batchModes.includes("private-key") && auth?.privateKeyPath !== undefined)
	);
}

function unsupportedVia(
	resolution: QuickchrResolution,
	via: RouterOsProtocol,
	detail: string,
	context: Record<string, unknown> = {},
): CentrsError {
	// Alternatives must be actually dialable: never re-suggest the `--via` that
	// just failed, and only advertise `ssh` when its auth passes the same batch
	// gate {@link buildConnection} enforces.
	const available = (
		Object.entries(resolution.services) as [
			RouterOsProtocol,
			AnyServiceEndpoint,
		][]
	)
		.filter(
			([id, endpoint]) =>
				id !== via &&
				endpoint.available &&
				(id !== "ssh" ||
					hasUsableSshAuth(endpoint.auth as SshEndpointAuth | undefined)),
		)
		.map(([id]) => id);
	return new CentrsError({
		code: "quickchr/unsupported-via",
		summary: `quickchr machine "${resolution.name}" cannot serve \`--via ${via}\`: ${detail}.`,
		remediation:
			available.length > 0
				? `Pick one of the machine's live services with \`--via ${available.join("` / `--via ")}\`, or target the device directly without \`--quickchr\`.`
				: `The machine reports no live services; check it with \`quickchr inspect ${resolution.name}\`.`,
		context: {
			machine: resolution.name,
			via,
			availableServices: available,
			...context,
		},
	});
}

/**
 * Materialize the connection facts for one chosen `--via` from a resolved
 * quickchr machine — the named-live-provider consumption seam (#134 Phase 4).
 * Substitutes for `resolveTarget`/`resolveAuth`: host/port/TLS/auth come ONLY
 * from the descriptor's per-service endpoint (never the CDB, env, or the
 * `__default__` ladder), stamped with `provider` provenance.
 *
 * Failure modes are all `quickchr/unsupported-via`, never a silent fallback:
 * a `--via` the descriptor does not forward (quickchr v1 forwards
 * `rest-api`/`native-api`/`ssh` only), an endpoint quickchr marked
 * unavailable, or an SSH endpoint with no batch-capable (non-interactive)
 * auth — centrs must not password-prompt mid-fan-out.
 */
export function quickchrConnection(
	resolution: QuickchrResolution,
	via: RouterOsProtocol,
): QuickchrConnection {
	const endpoint = resolution.services[via];
	if (endpoint === undefined) {
		throw unsupportedVia(
			resolution,
			via,
			"the descriptor does not forward that service (quickchr v1 forwards rest-api/native-api/ssh)",
		);
	}
	return buildConnection(resolution, via, endpoint);
}

function buildConnection(
	resolution: QuickchrResolution,
	via: RouterOsProtocol,
	endpoint: AnyServiceEndpoint,
): QuickchrConnection {
	if (!isEndpointAvailable(endpoint)) {
		throw unsupportedVia(
			resolution,
			via,
			`the service is not available (${endpoint.unavailableReason})`,
			{ unavailableReason: endpoint.unavailableReason },
		);
	}

	const source = {
		kind: "provider" as const,
		key: `quickchr:${resolution.name}`,
	};
	const hostForUrl = formatHostForUrl(endpoint.host);
	let baseUrl: string;
	let scheme: "http" | "https";
	if (via === "ssh") {
		scheme = "http";
		baseUrl = `ssh://${hostForUrl}:${endpoint.port}`;
	} else if (via === "native-api") {
		scheme = endpoint.tls ? "https" : "http";
		baseUrl = `${endpoint.tls ? "api-ssl" : "api"}://${hostForUrl}:${endpoint.port}`;
	} else {
		scheme = endpoint.tls ? "https" : "http";
		baseUrl = `${scheme}://${hostForUrl}:${endpoint.port}/rest`;
	}

	const target: ResolvedTarget = {
		input: resolution.name,
		host: endpoint.host,
		port: endpoint.port,
		scheme,
		tls: endpoint.tls,
		baseUrl,
		identity: resolution.name,
		source,
		hostSource: source,
		portSource: source,
		sources: { host: source, port: source },
	};

	// Trust-by-provenance: a TLS endpoint presents the CHR's self-signed cert
	// and an SSH endpoint an ephemeral host key, and the descriptor carries no
	// trust material — so the provider's voucher for its loopback forward is the
	// trust anchor, surfaced as a warning (see QuickchrConnection.insecure).
	const insecure = via === "ssh" || endpoint.tls;
	const warnings = insecure
		? [
				{
					code: "transport/provider-trust",
					message:
						via === "ssh"
							? `quickchr machine "${resolution.name}": strict SSH host-key checking is relaxed for the ephemeral VM (loopback forward vouched by the provider).`
							: `quickchr machine "${resolution.name}": the ${via} endpoint uses the VM's self-signed TLS certificate; peer verification is relaxed (loopback forward vouched by the provider).`,
				},
			]
		: [];

	if (via === "ssh") {
		// The contract guarantees `auth` on an available SSH endpoint; treat a
		// malformed descriptor (missing auth / batchModes / a `private-key` batch
		// mode with no key path) as batch-incapable rather than crashing on a
		// field access or letting the SSH client fall back to ambient config.
		const auth = endpoint.auth as SshEndpointAuth | undefined;
		if (auth === undefined || !hasUsableSshAuth(auth)) {
			throw unsupportedVia(
				resolution,
				via,
				"the SSH endpoint has no usable batch-capable (non-interactive) auth mode, and centrs never password-prompts for a provider target",
				{ modes: auth?.modes ?? [], batchModes: auth?.batchModes ?? [] },
			);
		}
		return {
			target,
			auth: {
				username: auth.username,
				usernameSource: { ...source, key: `${source.key}:username` },
				password: "",
				passwordProvided: false,
				sshKey: auth.privateKeyPath,
				sshKeySource:
					auth.privateKeyPath !== undefined
						? { ...source, key: `${source.key}:ssh-key` }
						: undefined,
			},
			insecure,
			warnings,
		};
	}

	const auth = endpoint.auth as
		| { username: string; password?: string }
		| undefined;
	return {
		target,
		auth: {
			username: auth?.username,
			usernameSource:
				auth?.username !== undefined
					? { ...source, key: `${source.key}:username` }
					: undefined,
			password: auth?.password ?? "",
			passwordProvided: auth?.password !== undefined,
			passwordSource:
				auth?.password !== undefined
					? { ...source, key: `${source.key}:password` }
					: undefined,
		},
		insecure,
		warnings,
	};
}
