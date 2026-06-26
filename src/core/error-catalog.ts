/**
 * The centrs error-code catalog: the enumerable source of truth for every
 * `CentrsError` code the codebase can produce.
 *
 * The constitution (`docs/CONSTITUTION.md`, "Error URL scheme") requires one
 * human page per error code at `https://tikoci.github.io/centrs/errors/<code>`
 * and states that a missing page is a centrs bug. This catalog is that list, in
 * code (not generated docs): the per-code pages under `docs/errors/` are
 * generated from it, and `test/unit/error-pages.test.ts` enforces three-way
 * consistency between this catalog, the live `code:` literals in `src/`, and the
 * pages on disk.
 *
 * Contributor contract: when you introduce a new error code, add an entry here
 * AND a `docs/errors/<code>.md` page in the same change, or the drift guard
 * fails. See `.github/instructions/actionable-errors.instructions.md`.
 *
 * Summaries are canonical one-liners describing the fault class — not the
 * interpolated, per-instance `summary` a given throw site builds.
 */

import { type CentrsErrorCode, ERROR_DETAILS_BASE_URL } from "../errors.ts";

export { ERROR_DETAILS_BASE_URL };

export interface ErrorCatalogEntry {
	code: CentrsErrorCode;
	summary: string;
}

/** Every error code centrs can produce, with a canonical one-line summary. */
export const errorCatalog: readonly ErrorCatalogEntry[] = [
	// auth/*
	{
		code: "auth/failed",
		summary: "RouterOS rejected the stored credentials for the device.",
	},

	// cdb/*
	{
		code: "cdb/already-exists",
		summary: "A CDB entry with that target already exists.",
	},
	{
		code: "cdb/created",
		summary: "A new CDB file was created at the resolved location.",
	},
	{
		code: "cdb/decrypt-failed",
		summary:
			"The encrypted CDB could not be decrypted (wrong or missing password).",
	},
	{
		code: "cdb/empty-group",
		summary: "The named CDB group contains no records.",
	},
	{
		code: "cdb/invalid-option",
		summary: "A comment kv-soup option carried an invalid value.",
	},
	{
		code: "cdb/invalid-record",
		summary:
			"A device record failed schema validation (blank target or wrong field type).",
	},
	{ code: "cdb/not-found", summary: "The CDB file could not be found." },
	{
		code: "cdb/not-found-target",
		summary: "No CDB entry matched the requested target string.",
	},
	{
		code: "cdb/override-applied",
		summary:
			"A comment kv-soup override replaced a resolved setting (informational).",
	},
	{ code: "cdb/parse-failed", summary: "The CDB file could not be parsed." },
	{
		code: "cdb/password-not-needed",
		summary:
			"A --cdb-password was supplied for an unencrypted CDB and was ignored.",
	},
	{
		code: "cdb/password-required",
		summary: "The CDB is encrypted; a --cdb-password is required to read it.",
	},
	{
		code: "cdb/reserved-key",
		summary: "Comment kv-soup cannot carry a first-class CDB field.",
	},
	{
		code: "cdb/reserved-option",
		summary: "A reserved comment kv-soup option was rejected.",
	},
	{
		code: "cdb/target-not-registered",
		summary:
			"The target is not on the CDB allowlist. Register it with centrs_devices (op add) first.",
	},
	{
		code: "cdb/unknown-field",
		summary: "An unknown CDB field name was referenced.",
	},
	{
		code: "cdb/unknown-option",
		summary: "An unknown comment kv-soup option was encountered.",
	},
	{
		code: "cdb/write-not-permitted",
		summary:
			"The device's CDB record is mcp=ro; MCP writes are not permitted until it is set to mcp=rw.",
	},

	// discover/*
	{
		code: "discover/broadcast-unavailable",
		summary:
			"The MNDP listener could not enable UDP broadcast; discovery continued passively without sending refresh probes.",
	},
	{ code: "discover/failed", summary: "MNDP discovery failed." },

	// identity/*
	{
		code: "identity/ambiguous",
		summary: "The target matches more than one CDB entry.",
	},
	{
		code: "identity/no-match",
		summary:
			"The target has no CDB entry matching the requested --match selector.",
	},

	// input/*
	{
		code: "input/invalid-command",
		summary: "The request shape was invalid (bad or missing arguments).",
	},
	{
		code: "input/invalid-match",
		summary:
			"The --match value is not a supported selector (user=, target=, or a record-type token).",
	},
	{
		code: "input/invalid-path",
		summary:
			"A file path contains a character the transport cannot quote (e.g. a quote or newline).",
	},
	{
		code: "input/invalid-routeros-path",
		summary: "The RouterOS path is malformed (it must be slash-prefixed).",
	},
	{
		code: "input/invalid-target",
		summary: "The target string is invalid for the requested operation.",
	},
	{
		code: "input/local-file-not-found",
		summary: "A local file required for the transfer could not be read.",
	},
	{
		code: "input/mac-address",
		summary: "The value is not a valid 6-octet MAC address.",
	},
	{
		code: "input/max-results-exceeded",
		summary: "Output exceeded the requested byte budget.",
	},

	// internal/*
	{
		code: "internal/devices-failed",
		summary: "The devices command failed with an unexpected internal error.",
	},
	{
		code: "internal/mcp-start",
		summary: "The MCP server failed to start.",
	},
	{
		code: "internal/mcp-tool",
		summary: "An MCP tool handler failed with an unexpected internal error.",
	},
	{
		code: "internal/native-api-length",
		summary: "A native-API word length could not be encoded.",
	},
	{
		code: "internal/unhandled",
		summary: "An unexpected internal error occurred (this is a centrs bug).",
	},
	{
		code: "internal/unreachable",
		summary: "An unreachable code path was reached (this is a centrs bug).",
	},

	// mndp/*
	{
		code: "mndp/encode-failed",
		summary: "An MNDP field could not be encoded.",
	},
	{
		code: "mndp/listen-failed",
		summary: "The MNDP UDP listener could not bind.",
	},
	{
		code: "mndp/malformed",
		summary: "A received MNDP datagram could not be decoded.",
	},

	// routeros/*
	{
		code: "routeros/api-fatal",
		summary: "The RouterOS native API returned a fatal sentence.",
	},
	{
		code: "routeros/api-protocol",
		summary: "A RouterOS native API reply could not be parsed.",
	},
	{
		code: "routeros/api-trap",
		summary:
			"The RouterOS native API returned a !trap with no more specific mapping.",
	},
	{
		code: "routeros/btest-connection-count-single-stream",
		summary:
			"centrs sends --connection-count to the server but still drives a single TCP stream; multi-stream fan-out is not yet implemented.",
	},
	{
		code: "routeros/btest-protocol",
		summary: "A bandwidth-test (btest) packet could not be decoded.",
	},
	{
		code: "routeros/btest-too-many-sessions",
		summary:
			"The btest server refused a client because max-sessions is reached.",
	},
	{
		code: "routeros/btest-udp-tx-size-ignored",
		summary:
			"For UDP --direction both, the btest wire protocol carries a single tx-size; --remote-udp-tx-size is ignored and --local-udp-tx-size is used for both directions.",
	},
	{
		code: "routeros/command-failed",
		summary: "RouterOS reported a command failure.",
	},
	{
		code: "routeros/ec-srp5-protocol",
		summary: "An EC-SRP5 authentication message or key could not be processed.",
	},
	{
		code: "routeros/error",
		summary: "RouterOS returned an error executing the command.",
	},
	{
		code: "routeros/invalid-value",
		summary: "RouterOS rejected the value supplied for an argument.",
	},
	{
		code: "routeros/mac-telnet-error",
		summary: "The device reported a MAC-Telnet error.",
	},
	{
		code: "routeros/mac-telnet-not-ready",
		summary: "Input was sent before the MAC-Telnet session was ready.",
	},
	{
		code: "routeros/mac-telnet-protocol",
		summary: "A MAC-Telnet packet could not be decoded.",
	},
	{
		code: "routeros/mac-telnet-unsupported-auth",
		summary: "The device requested an unsupported MAC-Telnet auth mode.",
	},
	{
		code: "routeros/protocol-not-implemented",
		summary: "The requested protocol is planned but not implemented yet.",
	},
	{
		code: "routeros/request-failed",
		summary: "A RouterOS REST request failed with no more specific mapping.",
	},
	{
		code: "routeros/session-closed",
		summary: "RouterOS closed the session before the request completed.",
	},
	{
		code: "routeros/unknown-attribute",
		summary: "RouterOS does not recognize the supplied attribute.",
	},
	{
		code: "routeros/unknown-path",
		summary: "RouterOS does not recognize the command path.",
	},
	{
		code: "routeros/unsupported-capability",
		summary: "The chosen protocol does not support this command capability.",
	},

	// settings/*
	{
		code: "settings/invalid-boolean",
		summary: "A boolean-like setting received a non-boolean value.",
	},
	{
		code: "settings/invalid-format",
		summary: "An unsupported output format was requested.",
	},
	{
		code: "settings/invalid-integer",
		summary: "An integer setting received a non-integer or out-of-range value.",
	},
	{
		code: "settings/invalid-timeout",
		summary: "A timeout setting received an invalid value.",
	},
	{
		code: "settings/invalid-via",
		summary: "An unsupported protocol identifier was supplied to --via.",
	},
	{
		code: "settings/unsafe-protocol-blocked",
		summary:
			"A cleartext protocol (e.g. ftp) was requested without the explicit ALLOW_UNSAFE_PROTOCOLS opt-in.",
	},

	// target/*
	{
		code: "target/mac-not-in-arp",
		summary:
			"The MAC is not in the host ARP cache, so it cannot be resolved to an IP.",
	},
	{
		code: "target/mac-required",
		summary: "The chosen L2 transport (mac-telnet) needs a MAC-address target.",
	},
	{
		code: "target/mac-unresolved",
		summary: "The MAC target could not be resolved to a host.",
	},
	{
		code: "target/unresolved",
		summary: "No host could be resolved for the operation.",
	},

	// transport/*
	{
		code: "transport/auth-failed",
		summary: "RouterOS rejected the credentials over the transport.",
	},
	{
		code: "transport/auto-method",
		summary:
			"Auto-selection moved the operation to a different method (informational auto-hop).",
	},
	{
		code: "transport/capability-unsupported",
		summary: "The chosen transport cannot perform this kind of operation.",
	},
	{
		code: "transport/checksum-unavailable",
		summary:
			"No file digest is available over the transport, so integrity was verified by size instead.",
	},
	{
		code: "transport/connection-closed",
		summary: "The transport connection was closed before a result.",
	},
	{
		code: "transport/connection-refused",
		summary: "The device refused the connection.",
	},
	{
		code: "transport/dns",
		summary: "The device host name could not be resolved.",
	},
	{
		code: "transport/host-key-mismatch",
		summary: "The device's SSH host key did not match the known key.",
	},
	{
		code: "transport/incomplete-transfer",
		summary:
			"A file transfer settled at fewer bytes than expected (verify mismatch).",
	},
	{
		code: "transport/insecure-trust",
		summary:
			"Peer verification was disabled via --insecure (TLS / SSH host-key checks skipped).",
	},
	{
		code: "transport/local-tool-missing",
		summary:
			"A required local CLI (e.g. the OpenSSH `sftp` client) is not installed or not on PATH.",
	},
	{
		code: "transport/network",
		summary: "A network request to the device failed.",
	},
	{
		code: "transport/timeout",
		summary: "The transport request timed out.",
	},
	{
		code: "transport/tls-certificate",
		summary: "TLS certificate validation failed for the device.",
	},
	{
		code: "transport/unreachable",
		summary: "The device could not be reached over the chosen transport.",
	},
	{
		code: "transport/unsupported-operation",
		summary: "The chosen transport does not support this operation.",
	},

	// usage/*
	{
		code: "usage/confirmation-required",
		summary:
			"A write-shaped command needs explicit confirmation (pass confirm:true / --yes after review).",
	},
	{
		code: "usage/conflicting-flags",
		summary: "Two or more supplied flags conflict.",
	},
	{
		code: "usage/invalid-concurrency",
		summary: "The --concurrency value must be an integer >= 1.",
	},
	{
		code: "usage/missing-group",
		summary: "The operation requires a non-empty --group value.",
	},
	{
		code: "usage/not-implemented",
		summary:
			"A recognized command form is reserved but not implemented yet (e.g. the interactive `devices edit` editor).",
	},
	{
		code: "usage/target-exists",
		summary:
			"The destination already exists and would be overwritten; pass --force to replace it.",
	},
	{
		code: "usage/timeout-out-of-range",
		summary: "The requested timeout is outside the allowed range.",
	},

	// validation/*
	{
		code: "validation/not-implemented",
		summary: "The requested validation feature is not implemented yet.",
	},
	{
		code: "validation/option",
		summary: "An unknown option value was supplied.",
	},
	{
		code: "validation/syntax",
		summary: "RouterOS rejected the command syntax during the :parse gate.",
	},
	{
		code: "validation/unknown-attribute",
		summary:
			"An attribute is not valid for the path/verb per /console/inspect.",
	},
	{
		code: "validation/unknown-path",
		summary: "The RouterOS path does not expose the requested command.",
	},
];

/** Set of all catalog codes, for fast membership checks in tests/resources. */
export const errorCatalogCodes: ReadonlySet<string> = new Set(
	errorCatalog.map((entry) => entry.code),
);

/** The stable details URL for a code: base URL + the slash-namespaced code. */
export function detailsUrlForCode(code: string): string {
	return `${ERROR_DETAILS_BASE_URL}${code}`;
}
