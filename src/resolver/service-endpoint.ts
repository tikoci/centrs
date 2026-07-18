/**
 * The neutral per-service endpoint shape — the connection-fact origin ("Axis B")
 * for a resolved target, decoupled from *how* the member was selected ("Axis A").
 *
 * This is the load-bearing scaffold for the resolution-provider refactor
 * (`docs/CONSTITUTION.md` → Resolution providers; centrs #174). Two provider
 * kinds feed it:
 *
 *   - **Selector-source** — participates in the `--group`/`--where`/`--all`/
 *     `--near`/`--bbox` selector grammar. **CDB** today; **TikTOML** next (#137).
 *     CDB is the *degenerate single-endpoint* case: one record yields one
 *     host/port/auth, materialized lazily by `./target.ts` once `--via` is known,
 *     so a CDB member never needs a populated {@link ServiceEndpointMap}.
 *   - **Named-live-provider** — addressed only by an explicit named flag, never
 *     matched by selectors, fanned out by repeating the flag; owns an ephemeral
 *     endpoint so it also bypasses the settings/`__default__` ladder and conflicts
 *     with `--host`/`--port`/`--username`/`--password`/`--ssh-key`. **quickchr**
 *     (`--quickchr <name>`, #134). A live provider resolves a member into a
 *     *populated* per-service map, because it genuinely exposes different
 *     host/port/auth per transport (e.g. a SLiRP-forwarded loopback port per
 *     service). Flattening that to a single host/port is the exact refactor #174
 *     exists to prevent — TikTOML's `services` block is per-service too.
 *
 * The shape here deliberately mirrors quickchr's published descriptor contract
 * (`tikoci/quickchr` `docs/centrs-interface.md`, `ServiceEndpoint`/
 * `SshServiceEndpoint`), which states that centrs reuses *this same internal
 * type* for TikTOML resolution. It is provider-neutral: `source.provider` is a
 * free string, not a quickchr literal. Mapping a resolved endpoint's auth onto
 * centrs' {@link ../resolver/target.ts | ResolvedAuth} (notably
 * `privateKeyPath` → `sshKey`) is the provider adapter's job, not this type's.
 *
 * Phase 1 (this file) defines the contract only; the quickchr provider adapter
 * that *produces* a map, and the `--via` consumer that *reads* `map[via]`, land
 * with the `--quickchr` plumbing (#134 Phase 2+).
 */

import type { RouterOsProtocol } from "../protocols/index.ts";

/** Provenance for a resolved endpoint — which provider vouched for it. */
export interface ServiceEndpointSource {
	/** Provider identity, e.g. `"quickchr"` or `"tiktoml"`. Neutral by design. */
	provider: string;
	/** Provider-internal forward name backing the service (e.g. `"api-ssl"`), for provenance. */
	portMappingName?: string;
}

/** REST/native-api auth. RouterOS shares one credential across REST and native. */
export interface ServiceEndpointAuth {
	username: string;
	password?: string;
	/** Pre-encoded HTTP Basic value, when the provider supplies one directly. */
	basic?: string;
	/** Pre-formed auth header value, when the provider supplies one directly. */
	header?: string;
}

/** SSH auth. Same credential vocabulary `+ key path`, plus batch-mode capability. */
export interface SshEndpointAuth {
	username: string;
	/**
	 * Path to a usable private key. Populated only when the provider has actually
	 * verified a batch (non-interactive) login with it — maps to
	 * {@link ../resolver/target.ts | ResolvedAuth.sshKey} in the provider adapter.
	 */
	privateKeyPath?: string;
	/** Every auth mode the endpoint accepts. */
	modes: Array<"private-key" | "agent-or-config" | "password">;
	/**
	 * The batch-capable subset. This is the gate centrs enforces for `--via ssh`
	 * and `transfer --via sftp`: an empty list means no non-interactive handoff is
	 * possible, so centrs must emit a typed unsupported-capability error rather
	 * than prompt for a password or silently fall back (#134 Phase 4).
	 */
	batchModes: Array<"private-key" | "agent-or-config">;
	passwordAvailable?: boolean;
}

/** Fields shared by every available endpoint regardless of auth flavor. */
interface AvailableEndpointBase {
	available: true;
	/** Hostname/IP to dial — NOT a port. `"127.0.0.1"` for a SLiRP-forwarded service. */
	host: string;
	port: number;
	guestPort?: number;
	transport: "tcp" | "udp";
	/** True for TLS-backed endpoints (https / api-ssl); SSH is always `false` (own transport security). */
	tls: boolean;
	url?: string;
	source?: ServiceEndpointSource;
}

/** An endpoint the provider could not vouch for; a consumer MUST gate on `available` before dialing. */
export interface UnavailableEndpoint {
	available: false;
	unavailableReason: string;
	/** Best-effort echoes only — never dial these without a re-resolve. */
	host?: string;
	port?: number;
	guestPort?: number;
	transport?: "tcp" | "udp";
	tls?: boolean;
	url?: string;
	source?: ServiceEndpointSource;
}

/** One per-service endpoint (rest-api / native-api). */
export type ServiceEndpoint =
	| (AvailableEndpointBase & { auth?: ServiceEndpointAuth })
	| UnavailableEndpoint;

/** The SSH endpoint — same union, with SSH-specific auth substituted. */
export type SshServiceEndpoint =
	| (AvailableEndpointBase & { auth: SshEndpointAuth })
	| UnavailableEndpoint;

/** Any resolved endpoint, whatever the service. */
export type AnyServiceEndpoint = ServiceEndpoint | SshServiceEndpoint;

/**
 * The endpoint type for a given `--via` id. `ssh` carries the SSH-specific
 * {@link SshServiceEndpoint} (its available form guarantees `auth: SshEndpointAuth`
 * with `batchModes`, the gate Phase 4 enforces for `--via ssh`/`transfer --via
 * sftp`); every other transport uses the shared credential {@link ServiceEndpoint}.
 */
export type ServiceEndpointFor<K extends RouterOsProtocol> = K extends "ssh"
	? SshServiceEndpoint
	: ServiceEndpoint;

/**
 * A member's per-service connection facts, keyed by centrs `--via` id.
 *
 * Partial by design: a provider may cover only a subset of the eight protocols
 * (quickchr v1 covers `rest-api`/`native-api`/`ssh`). A `--via` whose key is
 * absent is a typed unsupported-provider error at consume time, not a silent
 * fallback. CDB never populates this map (its single endpoint is materialized by
 * `./target.ts`); only named-live-providers do.
 *
 * Keyed by service so per-`--via` precision survives: `map.ssh` is a
 * {@link SshServiceEndpoint}, not a widened `AnyServiceEndpoint`, so a consumer
 * reading `map.ssh` keeps the SSH `auth`/`batchModes` guarantee without a cast.
 */
export type ServiceEndpointMap = {
	[K in RouterOsProtocol]?: ServiceEndpointFor<K>;
};

/**
 * Narrow an endpoint to its available form (the only form safe to dial). Generic
 * so the caller's precise union is preserved: an {@link SshServiceEndpoint} narrows
 * to its available arm (`auth: SshEndpointAuth` required), not the widened base.
 */
export function isEndpointAvailable<T extends AnyServiceEndpoint>(
	endpoint: T,
): endpoint is Extract<T, { available: true }> {
	return endpoint.available;
}
