/**
 * The centrs error-code catalog: the enumerable source of truth for every
 * `CentrsError` code the codebase can produce.
 *
 * The constitution (`docs/CONSTITUTION.md`, "Error URL scheme") requires one
 * human page per error code at `https://tikoci.dev/centrs/errors/<code>/`
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

import {
	type CentrsErrorCode,
	ERROR_DETAILS_BASE_URL,
	errorDetailsUrl,
} from "../errors.ts";

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
		summary:
			"Batch SSH authentication failed (execute --via ssh, sftp transfer).",
	},

	// cdb/*
	{
		code: "cdb/already-exists",
		summary:
			"devices add refused: a saved device with that target and user already exists. Nothing was written.",
	},
	{
		code: "cdb/conflict",
		summary:
			"The CDB changed after it was loaded; the stale write was refused so no change is lost.",
	},
	{
		code: "cdb/create-failed",
		summary: "A new CDB file could not be created at the resolved location.",
	},
	{
		code: "cdb/created",
		summary:
			"No CDB was at the default path, so centrs created an empty one there (warning).",
	},
	{
		code: "cdb/decrypt-failed",
		summary:
			"The encrypted CDB could not be decrypted (wrong or missing password).",
	},
	{
		code: "cdb/encrypt-failed",
		summary: "The CDB could not be rewritten with encryption.",
	},
	{
		code: "cdb/plaintext-backups",
		summary:
			"CDB backups may still contain plaintext credentials after encryption.",
	},
	{
		code: "cdb/empty-group",
		summary:
			"The named CDB group contains no records: a warning for a read, an error for a write-shaped fan-out.",
	},
	{
		code: "cdb/empty-selection",
		summary:
			"The target selection matched no CDB records: a warning for a read, an error for a write-shaped fan-out.",
	},
	{
		code: "cdb/file-exists",
		summary:
			"`devices init` found a CDB already at the resolved location and wrote nothing.",
	},
	{
		code: "cdb/invalid-option",
		summary:
			"A saved device property has a value centrs cannot use; it is ignored and the next setting source applies (warning).",
	},
	{
		code: "cdb/invalid-record",
		summary:
			"A device record failed validation (a blank target or a wrong field type). Nothing was written.",
	},
	{
		code: "cdb/lock-unsupported",
		summary:
			"The CDB filesystem does not support the hard links required for write locking.",
	},
	{
		code: "cdb/locked",
		summary:
			"Another writer held the CDB lock past the wait timeout; nothing was written.",
	},
	{
		code: "cdb/not-found",
		summary: "The CDB file does not exist, or could not be created.",
	},
	{
		code: "cdb/not-found-target",
		summary: "No CDB entry matched the requested target string.",
	},
	{
		code: "cdb/override-applied",
		summary:
			"The device's saved via property was overridden by --via or CENTRS_VIA (warning).",
	},
	{ code: "cdb/parse-failed", summary: "The CDB file could not be parsed." },
	{
		code: "cdb/password-not-needed",
		summary:
			"A CDB password was given for an unencrypted CDB and was ignored (warning).",
	},
	{
		code: "cdb/password-required",
		summary:
			"A CDB password is required for decryption or explicit encryption.",
	},
	{
		code: "cdb/reserved-key",
		summary:
			"devices add or set got key=value for a field with its own flag (user, password, group, profile, session). Nothing was written.",
	},
	{
		code: "cdb/reserved-option",
		summary:
			"A saved device has user, password, group, profile or session as a key=value property; it is ignored (warning).",
	},
	{
		code: "cdb/target-not-registered",
		summary:
			"The target is not a registered CDB device, and this surface only acts on registered devices. Register it with centrs_devices (op add) first.",
	},
	{
		code: "cdb/unknown-field",
		summary:
			"A device record holds CDB fields centrs cannot decode; they are kept byte for byte (warning).",
	},
	{
		code: "cdb/unknown-option",
		summary:
			"A device's key=value is not a centrs device property. centrs keeps it, but it has no effect; with --strict, devices add and set refuse it.",
	},
	{
		code: "cdb/write-not-permitted",
		summary:
			"An MCP write was refused because the device's mcp property is ro (the default). Nothing was sent.",
	},

	// discover/*
	{
		code: "discover/broadcast-unavailable",
		summary:
			"UDP broadcast could not be enabled, so discover only listened for unprompted announcements (warning).",
	},
	{
		code: "discover/failed",
		summary: "MNDP discovery failed with no more specific code.",
	},

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
		code: "input/empty-stdin",
		summary:
			"A flag that reads its value from stdin (e.g. `--password-stdin`) received nothing.",
	},
	{
		code: "input/incomplete-gps",
		summary:
			"A device location was given without both lat and lon. Nothing was written.",
	},
	{
		code: "input/invalid-altitude",
		summary:
			"The altitude is not a number, or the altitude type is not MSL or AGL. Nothing was written.",
	},
	{
		code: "input/invalid-bbox",
		summary:
			"The --bbox is not south,west,north,east with south <= north and west <= east. Nothing was read or sent.",
	},
	{
		code: "input/invalid-command",
		summary:
			"The command line or request was malformed: an unknown command or flag, or a missing or invalid argument.",
	},
	{
		code: "input/invalid-coordinate",
		summary:
			"A latitude or longitude is not a decimal-degrees number in range. Nothing was written or sent.",
	},
	{
		code: "input/invalid-match",
		summary:
			"The --match value is not user=, target= or a record type. Nothing was changed.",
	},
	{
		code: "input/invalid-path",
		summary:
			"An api endpoint or file path cannot be sent as given (row id, empty path, or a character SFTP cannot quote). Nothing was sent.",
	},
	{
		code: "input/invalid-query",
		summary:
			"A --query expression does not parse as a `print where` condition.",
	},
	{
		code: "input/invalid-radius",
		summary:
			"The --near radius is not a non-negative number with an optional m/km/mi/ft unit. Nothing was read or sent.",
	},
	{
		code: "input/invalid-routeros-path",
		summary:
			"The RouterOS path is malformed: not slash-prefixed, a segment that is not a menu name, or characters a REST URL would reinterpret.",
	},
	{
		code: "input/invalid-stdin",
		summary:
			"A flag that reads its value from stdin (e.g. `--password-stdin`) received bytes that are not valid UTF-8 text, or began with a byte-order mark.",
	},
	{
		code: "input/invalid-target",
		summary: "The target string is invalid for the requested operation.",
	},
	{
		code: "input/local-destination",
		summary:
			"A local download destination cannot be written (missing parent directory, a directory, or no permission).",
	},
	{
		code: "input/local-file-not-found",
		summary:
			"A local file centrs was given could not be read. Nothing was sent.",
	},
	{
		code: "input/mac-address",
		summary:
			"The value is not a MAC address of six hex octets. Nothing was sent.",
	},
	{
		code: "input/max-results-exceeded",
		summary:
			"The result was larger than the --max-results budget, so it was withheld; an execute command already ran.",
	},
	{
		code: "input/unsupported-query",
		summary:
			"A --query uses something the RouterOS API query cannot run (`~`, `in`, a `$variable` or `[command]`).",
	},

	// internal/*
	{
		code: "internal/byte-string",
		summary: "A binary RouterOS word held a character that is not a byte.",
	},
	{
		code: "internal/devices-failed",
		summary:
			"A devices command failed with an error centrs has no code for (a centrs bug).",
	},
	{
		code: "internal/mcp-start",
		summary: "centrs mcp failed to start; no MCP session began.",
	},
	{
		code: "internal/mcp-tool",
		summary:
			"An MCP tool failed with an error centrs has no code for (a centrs bug).",
	},
	{
		code: "internal/native-api-length",
		summary:
			"A native-API word length could not be encoded, so the command with that word was not sent (a centrs bug).",
	},
	{
		code: "internal/settings-failed",
		summary:
			"A settings command failed with an error centrs has no code for (a centrs bug).",
	},
	{
		code: "internal/unhandled",
		summary:
			"A command failed with an error centrs has no code for (a centrs bug).",
	},
	{
		code: "internal/unreachable",
		summary:
			"centrs reached a state its code treats as impossible (a centrs bug).",
	},

	// mndp/*
	{
		code: "mndp/encode-failed",
		summary:
			"An MNDP packet could not be built: a MAC or IPv4 field is malformed. Nothing was sent.",
	},
	{
		code: "mndp/listen-failed",
		summary: "The MNDP UDP listener could not bind.",
	},
	{
		code: "mndp/malformed",
		summary:
			"An MNDP datagram could not be decoded; discover skips it and counts it as a warning.",
	},

	// cmr/* — `execute --cmr` (#450)
	{
		code: "cmr/cancelled",
		summary:
			"The operation was cancelled before the command was sent to a CMR client.",
	},
	{
		code: "cmr/caller-policy-not-enforced",
		summary:
			"Warning: the controller login lacks a policy the CMR command runs with on the clients, and RouterOS does not check it.",
	},
	{
		code: "cmr/client-script-not-validated",
		summary:
			"Warning: a caller-addressed `/cmr/device/run-script` was validated as a controller request; its script was not validated on the clients.",
	},
	{
		code: "cmr/client-disconnected",
		summary:
			"CMR skipped a client that is not connected to its controller; the command was not sent.",
	},
	{
		code: "cmr/empty-selection",
		summary:
			"The CMR selection matched no device on the controller: for `--cmr`, a warning for a read and an error for a write; for a fleet command such as `/cmr/vlan/add`, a warning.",
	},
	{
		code: "cmr/membership-changed",
		summary:
			"A CMR client left the label selection or changed its key between validation and dispatch; the command was not sent.",
	},
	{
		code: "cmr/not-a-controller",
		summary:
			"The target does not answer `/cmr/device`; it is not a CMR controller.",
	},
	{
		code: "cmr/console-only",
		summary:
			"The CMR command is an interactive console view that breaks an API session, so centrs refused it before running it.",
	},
	{
		code: "cmr/outcome-unknown",
		summary:
			"The command was sent to a CMR client but no final status came back; it may still be running.",
	},
	{
		code: "cmr/output-truncated",
		summary:
			"Warning: CMR clipped a client's command output at its ~60 KiB cap.",
	},
	{
		code: "cmr/policy-denied",
		summary:
			"A CMR client refused a statement because CMR scripts run without the policy it needs; earlier statements already ran.",
	},
	{
		code: "cmr/rule-selects-every-device",
		summary:
			"Warning: a CMR rule command has no device `labels` (and, for VLAN, no `port-labels`), so the rule applies to every device, the controller included.",
	},
	{
		code: "cmr/selection-includes-controller",
		summary:
			"Warning: a CMR fleet command selects the controller's own row as well as its clients.",
	},
	{
		code: "cmr/selection-incomplete",
		summary:
			"The controller did not answer whether every device matches the labels, so nothing was run.",
	},
	{
		code: "cmr/validation-incomplete",
		summary:
			"A CMR client's validation result was incomplete or clipped, so the command was not sent to it.",
	},

	// quickchr/*
	{
		code: "quickchr/package-unavailable",
		summary: "The optional `@tikoci/quickchr` package is not installed.",
	},
	{
		code: "quickchr/unsupported",
		summary:
			"The installed `@tikoci/quickchr` is too old or speaks a newer descriptor version than centrs understands.",
	},
	{
		code: "quickchr/machine-not-found",
		summary: "No quickchr machine is registered under that name.",
	},
	{
		code: "quickchr/machine-stopped",
		summary:
			"The quickchr machine is not running, so it has no live connection facts.",
	},
	{
		code: "quickchr/unsupported-via",
		summary:
			"The chosen `--via` has no usable service on the quickchr machine (not forwarded, or marked unavailable).",
	},
	{
		code: "quickchr/ssh-auth-unavailable",
		summary:
			"The quickchr machine forwards SSH but vouches for no verified SSH key, so no non-interactive SSH/SFTP login is possible.",
	},

	// routeros/*
	{
		code: "routeros/action-timed-out",
		summary:
			"RouterOS dropped a command's reply at that command's own limit (native-API `action timed out`); the command may still be running or may have finished.",
	},
	{
		code: "routeros/api-fatal",
		summary: "RouterOS ended the native-API session with a !fatal reply.",
	},
	{
		code: "routeros/api-protocol",
		summary: "A RouterOS native API reply could not be parsed.",
	},
	{
		code: "routeros/api-trap",
		summary:
			"RouterOS reported an error on a native-API command, with a message centrs has no specific code for. The command may have partly run.",
	},
	{
		code: "routeros/btest-connection-count-single-stream",
		summary:
			"Fewer TCP data connections were opened than --connection-count requested (e.g. authenticated multi-connection is not yet supported), so throughput will not scale to the full count.",
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
		code: "routeros/invalid-value",
		summary: "RouterOS rejected the value supplied for an argument.",
	},
	{
		code: "routeros/mac-telnet-error",
		summary: "The device sent a MAC-Telnet error packet and the session ended.",
	},
	{
		code: "routeros/mac-telnet-not-ready",
		summary:
			"A MAC-Telnet session was used before it was open, or after it closed.",
	},
	{
		code: "routeros/mac-telnet-protocol",
		summary:
			"A MAC-Telnet datagram for this session could not be decoded, and centrs closed the session.",
	},
	{
		code: "routeros/mac-telnet-unsupported-auth",
		summary: "The device requested an unsupported MAC-Telnet auth mode.",
	},
	{
		code: "routeros/permission-denied",
		summary:
			"RouterOS refused the command because the user's group lacks a policy it needs.",
	},
	{
		code: "routeros/protocol-not-implemented",
		summary: "This command does not run over the requested --via protocol yet.",
	},
	{
		code: "routeros/request-failed",
		summary:
			"RouterOS reported an error on a REST, SSH or MAC-Telnet request, with a message centrs has no specific code for. The command may have partly run.",
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
		summary: "The --via protocol cannot do what this command needs.",
	},
	{
		code: "routeros/version-unsupported",
		summary:
			"The device's RouterOS version does not provide the operation this command needs.",
	},

	// settings/*
	{
		code: "settings/consequential-value",
		summary:
			"`settings set` accepted a syntactically valid value with a real, non-obvious consequence (e.g. a global --insecure default, or a transfer-via value gated elsewhere).",
	},
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
		code: "settings/reserved-key",
		summary:
			"`settings set`/`reset` refused a credential-shaped or self-referential CENTRS_* key.",
	},
	{
		code: "settings/skip-env-file-active",
		summary:
			"`settings print` ran under --skip-env-file; the shown centrs.env values would not apply to other commands run in the same environment.",
	},
	{
		code: "settings/unknown-key",
		summary:
			"`settings get`/`set` received a token that is not a recognized CENTRS_*-shaped setting.",
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
		summary:
			"No connectable host for this target: no target was given, --host or CENTRS_HOST was empty, or the selection named the credential-only __default__ record.",
	},

	// transport/*
	{
		code: "transport/auth-failed",
		summary: "RouterOS rejected the credentials over the transport.",
	},
	{
		code: "transport/auto-method",
		summary:
			"With no --via, transfer chose sftp because the upload is over 60 KB (warning).",
	},
	{
		code: "transport/cancel-unacknowledged",
		summary:
			"RouterOS did not acknowledge a stream's /cancel within the timeout; centrs ended the stream and closed the session locally.",
	},
	{
		code: "transport/capability-unsupported",
		summary: "The chosen transport cannot perform this kind of operation.",
	},
	{
		code: "transport/checksum-unavailable",
		summary:
			"RouterOS gives no file digest, so --verify checksum compared sizes instead (warning).",
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
		code: "transport/edge-auth-failed",
		summary:
			"An HTTP layer in front of RouterOS (auth proxy, tunnel edge, WAF) refused the request before RouterOS answered it.",
	},
	{
		code: "transport/host-key-mismatch",
		summary: "The device's SSH host key did not match the known key.",
	},
	{
		code: "transport/incomplete-transfer",
		summary:
			"A file transfer could not be verified: its size did not match, or RouterOS showed none.",
	},
	{
		code: "transport/insecure-trust",
		summary:
			"--insecure is set, so TLS certificates and SSH host keys were not verified (warning).",
	},
	{
		code: "transport/provider-trust",
		summary:
			"Peer verification is relaxed for a named-live-provider endpoint (a quickchr VM's self-signed TLS cert / ephemeral SSH host key), trusted by the provider's loopback-forward voucher.",
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
		code: "transport/stream-overflow",
		summary:
			"More stream replies were waiting unread than the buffer allows, so centrs ended the stream rather than drop any.",
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
		code: "transport/unsupported-operation",
		summary:
			"The transfer method cannot do this operation (copy over sftp, or an upload over 60 KB over rest/native). Nothing was sent.",
	},
	{
		code: "transport/write-outcome-unknown",
		summary:
			"Warning: a write failed after it was sent, so it may have run on the router; centrs did not retry it.",
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
		code: "usage/flag-after-separator",
		summary:
			"A centrs flag was written after `--`, where every token is RouterOS input.",
	},
	{
		code: "usage/invalid-concurrency",
		summary:
			"--concurrency is not a whole number of at least 1. Nothing was sent.",
	},
	{
		code: "usage/removed-flag",
		summary:
			"A flag or request field was removed; the error names its replacement.",
	},
	{
		code: "usage/stdin-ignored",
		summary:
			"stdin was redirected but the input came from the positional argument, so anything piped in was not analyzed.",
	},
	{
		code: "usage/stdin-is-tty",
		summary:
			"A flag that reads its value from stdin (e.g. `--password-stdin`) was given while stdin is a terminal.",
	},
	{
		code: "usage/fanout-not-supported",
		summary:
			"The command or mode cannot fan out across multiple targets (e.g. terminal, --listen/--stream).",
	},
	{
		code: "usage/invalid-cursor",
		summary:
			"An explain --cursor is not a byte offset inside the input being analyzed.",
	},
	{
		code: "usage/invalid-method",
		summary: "The -X/--method value is not a supported HTTP method.",
	},
	{
		code: "usage/missing-labels",
		summary: "`--cmr` was given without a `--labels` expression.",
	},
	{
		code: "usage/missing-group",
		summary:
			"A group fan-out was asked for with an empty group name. Nothing was sent.",
	},
	{
		code: "usage/missing-flag-value",
		summary:
			"A flag that needs a value was given none, or was followed by another flag.",
	},
	{
		code: "usage/not-implemented",
		summary:
			"This command form is recognized but not built yet (devices edit; transfer via scp, fetch or ftp). Nothing was sent.",
	},
	{
		code: "usage/target-exists",
		summary:
			"The destination already exists on the router, and centrs does not overwrite it without --force. Nothing was changed.",
	},
	{
		code: "usage/timeout-out-of-range",
		summary:
			"The --timeout is longer than REST's 60-second ceiling. Nothing was sent.",
	},

	// validation/*
	{
		code: "validation/not-followable",
		summary:
			"The RouterOS menu cannot be followed: it is a single record, or its print has no follow-only.",
	},
	{
		code: "validation/not-implemented",
		summary:
			"Retired: emitted by 0.1.0–0.1.7 for a validation feature that was not built yet.",
	},
	{
		code: "validation/menu-unavailable",
		summary:
			"RouterOS 7 publishes this menu or command, but this device does not have it — usually hardware, build or version.",
	},
	{
		code: "validation/option",
		summary: "An option value is outside what centrs accepts.",
	},
	{
		code: "validation/package-missing",
		summary:
			"This device has no such menu or command; MikroTik publishes it in a package that is likely not installed.",
	},
	{
		code: "validation/syntax",
		summary:
			"The command syntax was rejected by the validation gate — offline analysis, or the RouterOS :parse probe.",
	},
	{
		code: "validation/unknown-attribute",
		summary:
			"An attribute is not valid for the path/verb per /console/inspect.",
	},
	{
		code: "validation/unknown-path",
		summary:
			"The RouterOS path does not exist, or does not expose the requested command.",
	},
	{
		code: "wait/deadline-exceeded",
		summary:
			"The wait deadline passed before readiness or its condition was established.",
	},
	{
		code: "wait/interrupted",
		summary:
			"The wait was cancelled before readiness or its condition was established.",
	},
];

/** Set of all catalog codes, for fast membership checks in tests/resources. */
export const errorCatalogCodes: ReadonlySet<string> = new Set(
	errorCatalog.map((entry) => entry.code),
);

/** The stable details URL for a code: base URL + the slash-namespaced code + `/`. */
export function detailsUrlForCode(code: string): string {
	return errorDetailsUrl(code);
}
