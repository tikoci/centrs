/**
 * `execute --cmr`: run one validated RouterOS command on CMR clients through
 * their controller (#450).
 *
 * CMR (RouterOS 7.26beta1+) keeps a device inventory on a controller and runs
 * scripts on paired clients with `/cmr/device/run-script`. centrs talks only to
 * the controller, with the controller's credentials; a client's address is
 * never dialed. CMR is a selection source here, not a protocol: `--via` pins
 * the controller transport.
 *
 * Grounded on 7.26beta1 x86 CHR (#441 and the #450 probes; the device facts
 * this module relies on are asserted in `test/integration/execute-cmr.test.ts`):
 *
 *   - `run-script` rows are `{.section, device, status, output}` progress
 *     snapshots. They carry NO device id, and `device` is the controller's
 *     cached `identity@address`, which changed mid-call when a client dropped.
 *     So every call here selects exactly ONE device (`numbers=<.id>`): the rows
 *     of that call are that device's, with nothing to correlate.
 *   - `numbers` and `labels` together select their intersection; an empty one
 *     is refused up front with `failure: no devices selected` (nothing sent).
 *     That refusal is how a preflight call learns "not a member", and how a
 *     dispatch learns the label set moved since preflight.
 *   - `failed` with `timed out (6)` or `std failure: timeout (13)` (a ~60 s
 *     ceiling `timeout=` does not lift), and a cancelled call, all left the
 *     client script RUNNING; its side effects landed later. A call that did not
 *     end in a final row is an unknown outcome, never "did not run", and is
 *     never retried.
 *   - Output is clipped at ~60 KiB with an in-band `...(+N B)` and status
 *     `success`. A validation result therefore passes a completeness gate (a
 *     trailing nonce line) before its `:parse` text is classified.
 *   - Scripts run with only the `read`, `write`, `test` and `reboot` policies
 *     (no user session). `/user/add` and `/tool/sniffer` fail at RUN time with
 *     `not enough permissions (9)` although `:parse` accepted them, so that is
 *     a dispatch outcome (`cmr/policy-denied`), never a validation result.
 *   - A client cannot check its own key: inside `run-script`,
 *     `/cmr/client get local-id` reads `*****` (no `sensitive` policy), and
 *     `numbers=` takes `.id` or identity but not `ids`. So binding is a
 *     host-side `/cmr/device` read just before each call, not an atomic check.
 *   - `freeze-frame-interval=20ms` brings a trivial call from ~1 s to ~25 ms;
 *     `strategy`/`fail-policy` are pinned and `order` is never sent (it adds
 *     `pending` and policy-`skipped` statuses).
 *   - The caller's policy is not checked against the script (#456):
 *     `run-script` needs only `read` + `api` on the controller login, and a
 *     `!write !reboot` login wrote to and rebooted clients, the controller's
 *     own row included. The write gate here is the only one; a write run by
 *     such a login carries `cmr/caller-policy-not-enforced`.
 */

import {
	assertNotCmrDashboardIl,
	CMR_RUN_SCRIPT_PATH,
	CMR_SCRIPT_POLICIES,
	type CmrCallerPolicy,
	cmrCallerPolicyWarning,
	readCmrCallerPolicy,
} from "./core/cmr.ts";
import type {
	CentrsErrorEnvelope,
	CentrsSuccessEnvelope,
	CommonSettingsMeta,
	EnvelopeTargetMeta,
	EnvelopeValidationMeta,
	FanoutData,
	FanoutSummary,
	Warning,
} from "./core/envelope.ts";
import { notReachedReason } from "./core/envelope.ts";
import { isWriteShaped } from "./core/execute-command.ts";
import {
	buildFanoutEnvelope,
	NOT_SENT_TRANSPORT_CODES,
	resolveFanoutConcurrency,
	runBoundedPool,
	summarizeFanout,
} from "./core/fanout.ts";
import {
	assertCapability,
	type CapabilityRequirement,
	probeDeviceVersion,
} from "./core/preflight.ts";
import { mapRouterOsError } from "./core/routeros-errors.ts";
import { routerOsStringLiteral } from "./core/routeros-string.ts";
import { toYaml } from "./core/yaml.ts";
import {
	CentrsError,
	formatCentrsErrorText,
	serializeCentrsError,
	terminalSafeLine,
} from "./errors.ts";
import {
	disabledValidationMeta,
	type ExecuteEnvelope,
	type ExecuteOperationMeta,
	type ExecuteRequest,
	type ExecuteRequestSummary,
	offlineStagePassed,
	passedStages,
	promptForWriteConfirmation,
	type ResolvedExecuteRequest,
	renderExecuteEnvelope,
	resolveExecuteRequest,
} from "./execute.ts";
import { assertOfflineSyntax, type OfflineGateResult } from "./offline-gate.ts";
import {
	createProtocolAdapter,
	type ProtocolAdapter,
	type RouterOsProtocol,
} from "./protocols/index.ts";
import { classifyParseResult } from "./protocols/mac-telnet-console.ts";
import { redactTargetInput, toCoreSource } from "./resolver/index.ts";

/** The device-stage validator identity for a CMR client. */
export const CMR_VALIDATION_SOURCE = ":put [:parse ...] via cmr run-script";

/** CMR's hard per-call ceiling is ~60 s; stay under it so `timeout=` decides. */
export const CMR_MAX_CALL_TIMEOUT_MS = 55_000;

/** Local grace past the CMR `timeout=` before centrs stops waiting. */
export const CMR_CALL_GRACE_MS = 3_000;

/** Fixed per-call arguments (see the module header for why). */
const RUN_SCRIPT_PINNED = {
	"freeze-frame-interval": "20ms",
	strategy: "parallel",
	"fail-policy": "continue",
} as const;

const FINAL_STATUSES = new Set(["success", "failed", "skipped"]);
const TRUNCATION_MARKER = /\.\.\.\(\+(\d+) B\)\s*$/;
const TIMEOUT_OUTPUT =
	/^(?:timed out \(\d+\)|std failure: timeout \(\d+\))\s*$/;
const NO_DEVICES_SELECTED = /no devices selected/i;
/** run-script lacks `policy`, `sniff`, `sensitive` (…); `:parse` cannot see that. */
const POLICY_DENIED = /^not enough permissions \(9\).*$/m;
/** An invocation, optionally after a relative menu change (`/ip/address/;(evl …`). */
const ACCEPTED_IL = /^(?:\/[^\s;()]*;)?\(evl\s/;
/** A missing `/cmr/device`: native `no such command prefix`, REST `no such command or directory (cmr)`. */
const MISSING_MENU = /no such command (?:prefix|or directory)/i;

export interface ExecuteCmrRequest extends ExecuteRequest {
	/** RouterOS label expression (comma list; plain = OR, `+` AND, `-` AND NOT, `all`). */
	labels: string;
	/** Max controller calls in flight (default: the transport fan-out default). */
	concurrency?: number;
	/** Cancels the operation; members already sent become unknown outcomes. */
	signal?: AbortSignal;
}

/** One `/cmr/device` row, reduced to what binding needs. */
export interface CmrDevice {
	id: string;
	/** `<device key>/<controller key>` (hex); stable across rename and re-pair on 7.26beta1. */
	ids: string;
	identity: string;
	address?: string;
}

export interface CmrScriptRow {
	device: string;
	status: string;
	output: string;
	section: number;
}

export interface CmrScriptCall {
	numbers: string;
	labels: string;
	script: string;
	/** CMR `timeout=` in ms; the local wait adds {@link CMR_CALL_GRACE_MS}. */
	timeoutMs: number;
}

/**
 * What one single-device `run-script` call produced. `selected: false` is the
 * controller's up-front refusal (nothing sent). Otherwise `row` is the newest
 * row seen, and `error` says why the call ended without one being final.
 */
export interface CmrScriptOutcome {
	selected: boolean;
	/** The request reached the controller (native: the sentence was written). */
	sent: boolean;
	row?: CmrScriptRow;
	error?: CentrsError;
}

/** Controller seam: production wraps a protocol adapter; tests inject a fake. */
/** What a router without `/cmr/device` says about itself, read only on that failure. */
export interface CmrAbsence {
	/** `/system/resource` version. */
	version?: string;
	/** `/cmr/client` `controller-identity` / `controller-address`, when it is a client. */
	controllerIdentity?: string;
	controllerAddress?: string;
}

export interface CmrController {
	devices(): Promise<CmrDevice[]>;
	/** Explain a missing `/cmr/device`; each read is best effort. */
	absence?(): Promise<CmrAbsence>;
	/** The login's own group policy; `undefined` when it cannot be read. */
	callerPolicy?(): Promise<CmrCallerPolicy | undefined>;
	runScript(
		call: CmrScriptCall,
		signal: AbortSignal,
	): Promise<CmrScriptOutcome>;
	close(): Promise<void>;
}

export interface ExecuteCmrInternals {
	controller?: (
		resolved: ResolvedExecuteRequest,
		signal: AbortSignal,
	) => CmrController;
	nonce?: () => string;
}

export interface ExecuteCmrOperationMeta {
	kind: "cmr";
	concurrency: number;
	summary: FanoutSummary;
	request: ExecuteRequestSummary;
	/** Hoisted from the members: every member runs under the controller login. */
	auth?: { username?: string; passwordProvided: boolean };
	cmr: {
		labels: string;
		/** `/cmr/device` rows considered. */
		inventory: number;
		/** Rows the label expression selected. */
		selected: number;
		/** Members the command was sent to. */
		dispatched: number;
	};
}

export type ExecuteCmrData = FanoutData<unknown, ExecuteOperationMeta>;
export type ExecuteCmrEnvelope = CentrsSuccessEnvelope<
	ExecuteCmrData,
	ExecuteCmrOperationMeta
>;
export type ExecuteCmrErrorEnvelope =
	CentrsErrorEnvelope<ExecuteCmrOperationMeta>;

interface Member {
	device: CmrDevice;
	/** Final envelope once decided; undefined while still eligible to run. */
	result?: ExecuteEnvelope;
	validation: EnvelopeValidationMeta;
}

/**
 * Run `request.command` on every CMR client `request.labels` selects on the
 * controller `request` resolves to. Throws (outer error) only before anything
 * is dispatched: bad usage, an incomplete selection, a refused write gate.
 */
export async function executeCmr(
	request: ExecuteCmrRequest,
	env: Record<string, string | undefined> = Bun.env,
	internals: ExecuteCmrInternals = {},
): Promise<ExecuteCmrEnvelope> {
	const labels = request.labels.trim();
	if (labels.length === 0) {
		throw new CentrsError({
			code: "usage/missing-labels",
			summary:
				"`--cmr` needs a `--labels` expression naming the clients to run on.",
			remediation:
				"Pass RouterOS label syntax, e.g. `--labels all`, `--labels site-a,+edge` or `--labels lab,-controller`.",
		});
	}
	const resolved = await resolveExecuteRequest(request, env);
	const via = resolved.via.value;
	if (via !== "native-api" && via !== "rest-api") {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary: `\`--cmr\` talks to the controller over native-api or rest-api, not ${via}.`,
			remediation:
				"Drop `--via` (native-api is the default) or pin `--via native-api` / `--via rest-api`.",
			context: { via },
		});
	}
	const offline = resolved.validate.value
		? assertOfflineSyntax(resolved.command, { surface: "execute", via })
		: undefined;
	const signal = request.signal ?? new AbortController().signal;
	const concurrency = resolveFanoutConcurrency(request.concurrency, via);
	const callTimeoutMs = Math.min(
		resolved.timeoutMs.value,
		CMR_MAX_CALL_TIMEOUT_MS,
	);
	const write = isWriteShaped(resolved.canonical);
	const controllerName =
		resolved.target.identity ?? resolved.target.input ?? resolved.target.host;
	const controller = (internals.controller ?? adapterController)(
		resolved,
		signal,
	);
	const nonce = (internals.nonce ?? defaultNonce)();

	const warnings: Warning[] = [...resolved.warnings];
	try {
		// 1. Inventory and per-row preflight (membership + client validation).
		const before = await readInventoryBeforeDispatch(controller, signal);
		const preflightScript = resolved.validate.value
			? `:put [:parse ${routerOsStringLiteral(resolved.command)}]; :put "${nonce}"`
			: `:put "${nonce}"`;
		const preflight = await runBoundedPool(before, concurrency, (device) =>
			signal.aborted
				? Promise.resolve<CmrScriptOutcome>({
						selected: true,
						sent: false,
						error: cancelledError(),
					})
				: controller.runScript(
						{
							numbers: device.id,
							labels,
							script: preflightScript,
							timeoutMs: callTimeoutMs,
						},
						signal,
					),
		);
		if (signal.aborted) throw cancelledError();
		const unknownMembership = before.filter(
			(_, index) =>
				preflight[index]?.selected === true &&
				preflight[index]?.row === undefined,
		);
		if (unknownMembership.length > 0) {
			throw new CentrsError({
				code: "cmr/selection-incomplete",
				summary: `The controller did not say whether ${unknownMembership.length} CMR device(s) match \`${labels}\`, so nothing was run.`,
				remediation:
					"Check the controller is reachable and responsive, raise `--timeout`, then retry. A partial selection is never run.",
				context: {
					labels,
					devices: unknownMembership.map((d) => ({
						id: d.id,
						identity: d.identity,
					})),
					causes: unknownMembership.map((d) => {
						const error = preflight[before.indexOf(d)]?.error;
						return error ? error.code : "no reply";
					}),
				},
			});
		}

		const members: Member[] = [];
		before.forEach((device, index) => {
			const outcome = preflight[index];
			if (!outcome?.selected || !outcome.row) return;
			members.push(judgePreflight(device, outcome, resolved, offline, nonce));
		});
		if (members.length === 0) {
			const message = `No CMR device on the controller matches \`${labels}\`. Labels are case-sensitive and RouterOS accepts unknown ones silently.`;
			const context = { labels, inventory: before.length };
			// #460: RouterOS refuses an empty selection (`no devices selected`);
			// a write here must not exit 0 on a mistyped label.
			if (write) {
				throw new CentrsError({
					code: "cmr/empty-selection",
					summary: `${message} Nothing ran: a write-shaped command must select at least one client.`,
					remediation:
						"Check the labels with `centrs retrieve <controller> /cmr/device` (`labels`, `auto-labels`), then re-run. A read over the same labels succeeds with a warning instead.",
					context: { ...context, write: true },
				});
			}
			warnings.push({ code: "cmr/empty-selection", message, context });
		}

		// 2. Bind: a member whose `ids` changed since S1 was validated as another key.
		const middle = await readInventoryBeforeDispatch(controller, signal);
		for (const member of members) {
			if (member.result) continue;
			const now = middle.find((d) => d.id === member.device.id);
			if (!now || now.ids !== member.device.ids) {
				member.result = memberError(
					member,
					resolved,
					notDispatched(
						"cmr/membership-changed",
						`CMR device ${member.device.id} (${member.device.identity}) changed or left the inventory between validation and dispatch.`,
						{ before: member.device, after: now ?? null },
					),
				);
			}
		}

		// 3. One write gate, naming the blast radius. The login's policy is read
		// once, best effort: a failed read only loses the warning.
		const runnable = members.filter((m) => !m.result);
		if (write && runnable.length > 0) {
			const caller = await controller.callerPolicy?.().catch(() => undefined);
			const notEnforced =
				caller && cmrCallerPolicyWarning(caller, CMR_SCRIPT_POLICIES);
			if (notEnforced) warnings.push(notEnforced);
			await confirmCmrWrite(
				request,
				signal,
				resolved,
				controllerName,
				runnable.length,
				members.length - runnable.length,
				notEnforced,
			);
		}

		// 4. Dispatch: one call per member, no retry. The prompt and the pool
		// queue can both wait arbitrarily long after S2, so each member is
		// re-bound to the key it was validated on just before its own call.
		const dispatched = await runBoundedPool(
			runnable,
			concurrency,
			async (member) => {
				const unsent = (error: CentrsError) => ({
					member,
					outcome: { selected: true, sent: false, error },
				});
				if (signal.aborted) return unsent(cancelledError());
				const rebound = await rebindBeforeSend(controller, member, signal);
				if (rebound) return unsent(rebound);
				const outcome = await controller.runScript(
					{
						numbers: member.device.id,
						labels,
						script: resolved.command,
						timeoutMs: callTimeoutMs,
					},
					signal,
				);
				return { member, outcome };
			},
		);
		// S3 re-binds every sent result to the key it was validated on. If it
		// cannot be read (or the run was cancelled), sent results are unknown.
		const after =
			dispatched.length > 0 && !signal.aborted
				? await readInventory(controller).catch(() => undefined)
				: undefined;
		let sentCount = 0;
		for (const { member, outcome } of dispatched) {
			if (outcome.sent) sentCount += 1;
			const now = after?.find((d) => d.id === member.device.id);
			const binding =
				after === undefined
					? "unverified"
					: now?.ids === member.device.ids
						? "bound"
						: "drifted";
			member.result = applyMemberBudget(
				judgeDispatch(member, outcome, resolved, binding),
				member,
				resolved,
			);
		}

		const targets = members.map(
			(member) =>
				member.result ?? memberError(member, resolved, internalUndecided()),
		);
		const summary = summarizeFanout(targets);
		return buildFanoutEnvelope<
			unknown,
			ExecuteOperationMeta,
			ExecuteCmrOperationMeta
		>({
			summary,
			targets,
			warnings,
			settings: settingsMeta(resolved),
			via,
			target: controllerTargetMeta(resolved),
			operation: {
				kind: "cmr",
				concurrency,
				summary,
				request: requestSummary(resolved),
				cmr: {
					labels,
					inventory: before.length,
					selected: members.length,
					dispatched: sentCount,
				},
			},
		});
	} catch (error) {
		// An outer error keeps the warnings gathered before it, such as
		// `cmr/caller-policy-not-enforced` on a refused confirmation.
		if (error instanceof CentrsError && warnings.length > 0) {
			OUTER_ERROR_WARNINGS.set(error, [...warnings]);
		}
		throw error;
	} finally {
		await controller.close();
	}
}

/** Warnings an outer `executeCmr` error carried; read by {@link buildExecuteCmrErrorEnvelope}. */
const OUTER_ERROR_WARNINGS = new WeakMap<CentrsError, Warning[]>();

// ---------------------------------------------------------------------------
// Preflight and dispatch judgement
// ---------------------------------------------------------------------------

function judgePreflight(
	device: CmrDevice,
	outcome: CmrScriptOutcome,
	resolved: ResolvedExecuteRequest,
	offline: OfflineGateResult | undefined,
	nonce: string,
): Member {
	const row = outcome.row as CmrScriptRow;
	const member: Member = {
		device,
		validation: resolved.validate.value
			? devicePassed(resolved, offline)
			: disabledValidationMeta(),
	};
	if (row.status === "skipped") {
		member.validation = deviceNotReached(
			resolved,
			offline,
			"cmr/client-disconnected",
		);
		member.result = memberError(
			member,
			resolved,
			disconnectedError(device, row),
		);
		return member;
	}
	const incomplete = (why: string) => {
		member.validation = deviceNotReached(
			resolved,
			offline,
			"cmr/validation-incomplete",
		);
		member.result = memberError(
			member,
			resolved,
			notDispatched(
				"cmr/validation-incomplete",
				`The validation result from CMR device ${device.identity} was incomplete (${why}), so the command was not sent to it.`,
				{ id: device.id, status: row.status, output: row.output },
			),
		);
		return member;
	};
	if (!FINAL_STATUSES.has(row.status))
		return incomplete(
			outcome.error
				? `${outcome.error.code}, last status ${row.status}`
				: `last status ${row.status}`,
		);
	if (row.status !== "success")
		return incomplete(`status ${row.status}: ${row.output.trim()}`);
	const text = row.output.replaceAll("\r\n", "\n");
	if (TRUNCATION_MARKER.test(text)) return incomplete("output clipped by CMR");
	const lines = text.replace(/\n+$/, "").split("\n");
	if (lines.at(-1) !== nonce) return incomplete("completion marker missing");
	if (!resolved.validate.value) return member;
	const parse = lines.slice(0, -1).join("\n").trim();
	if (parse.length === 0) return incomplete("empty `:parse` return");
	try {
		classifyParseResult(parse, resolved.command, "cmr run-script");
		assertNotCmrDashboardIl(parse, resolved.command);
	} catch (error) {
		const rejected = error as CentrsError;
		member.validation = deviceRejected(resolved, offline, rejected);
		member.result = memberError(member, resolved, rejected);
		return member;
	}
	// Positive evidence: every accepted `:parse` return seen (structured,
	// console spacing, multi-statement, blocks, `:if`/`:foreach`; 7.24.5 and
	// 7.26beta1) starts `(evl `, after a relative menu change if the command
	// opens with one (7.26beta1). A comment-only script returns `/`.
	if (!ACCEPTED_IL.test(parse)) return incomplete("`:parse` return is not IL");
	return member;
}

function judgeDispatch(
	member: Member,
	outcome: CmrScriptOutcome,
	resolved: ResolvedExecuteRequest,
	binding: "bound" | "drifted" | "unverified",
): ExecuteEnvelope {
	const device = member.device;
	if (!outcome.selected) {
		return memberError(
			member,
			resolved,
			notDispatched(
				"cmr/membership-changed",
				`CMR device ${device.identity} no longer matched the labels at dispatch, so the command was not sent to it.`,
				{ id: device.id },
			),
		);
	}
	const row = outcome.row;
	if (!outcome.sent && !(row && FINAL_STATUSES.has(row.status))) {
		return memberError(member, resolved, outcome.error ?? cancelledError());
	}
	// CMR itself declined to send: nothing ran, whichever client this was.
	if (row?.status === "skipped") {
		return memberError(member, resolved, disconnectedError(device, row));
	}
	// A sent call whose member cannot be re-bound after dispatch (its `ids`
	// changed, or S3 was not read) has no attributable result.
	if (binding !== "bound") {
		return memberError(
			member,
			resolved,
			unknownOutcome(
				device,
				undefined,
				row,
				binding === "drifted"
					? "its `ids` changed during the call"
					: "the controller inventory was not re-read (cancelled or unreadable) to confirm which client answered",
			),
		);
	}
	if (!row || !FINAL_STATUSES.has(row.status)) {
		return memberError(
			member,
			resolved,
			unknownOutcome(device, outcome.error, row),
		);
	}
	if (row.status === "failed") {
		if (TIMEOUT_OUTPUT.test(row.output.trim())) {
			return memberError(
				member,
				resolved,
				unknownOutcome(device, undefined, row),
			);
		}
		// The diagnostic follows whatever the script printed before it.
		const denied = POLICY_DENIED.exec(row.output.replaceAll("\r\n", "\n"));
		if (denied) {
			return memberError(
				member,
				resolved,
				new CentrsError({
					code: "cmr/policy-denied",
					summary: `${device.identity} refused a statement: CMR runs scripts with only the read, write, test and reboot policies (\`${denied[0].trim()}\`). Any statements before it already ran.`,
					remediation:
						"A statement that needs another policy (`/user`, `/tool/sniffer`) cannot run through CMR. Check what the earlier statements changed (the output is in `context.output`), then run only the refused statement and the ones after it directly on the device, e.g. `centrs execute <device> -- '<command>'`.",
					context: {
						id: device.id,
						identity: device.identity,
						output: row.output,
					},
				}),
			);
		}
		return memberError(
			member,
			resolved,
			mapRouterOsError(row.output.trim(), {
				transport:
					resolved.via.value === "rest-api" ? "rest-api" : "native-api",
				context: { cmr: { id: device.id, identity: device.identity } },
			}),
		);
	}
	const warnings: Warning[] = [];
	const clipped = TRUNCATION_MARKER.exec(row.output);
	if (clipped) {
		warnings.push({
			code: "cmr/output-truncated",
			message: `CMR clipped the output from ${device.identity}: ${clipped[1]} more bytes were not returned.`,
			context: { id: device.id, missingBytes: Number(clipped[1]) },
		});
	}
	return {
		ok: true,
		data: { ret: row.output },
		warnings,
		tips: [],
		meta: {
			...memberMeta(member, resolved),
			...(clipped
				? {
						truncated: {
							truncated: true,
							reason: "CMR run-script output cap (~60 KiB)",
							serializedBytes: row.output.length + Number(clipped[1]),
						},
					}
				: {}),
		},
	};
}

/**
 * `--max-results` per member, as plain execute fan-out applies it per target:
 * the member's rendered envelope in the requested format, in UTF-8 bytes. The
 * command already ran, so the error says so rather than implying it did not.
 */
function applyMemberBudget(
	envelope: ExecuteEnvelope,
	member: Member,
	resolved: ResolvedExecuteRequest,
): ExecuteEnvelope {
	const budget = resolved.maxResultsBytes?.value;
	if (!budget || !envelope.ok) return envelope;
	const format = resolved.format.value;
	const requiredBytes = new TextEncoder().encode(
		renderExecuteEnvelope(envelope, format, {
			verbose: format === "text" && resolved.verbose,
		}),
	).length;
	if (requiredBytes <= budget) return envelope;
	const device = member.device;
	return memberError(
		member,
		resolved,
		new CentrsError({
			code: "input/max-results-exceeded",
			summary: `The command ran on ${device.identity}, but its result (${requiredBytes} bytes) exceeded the requested ${budget}-byte budget, so it is not returned.`,
			remediation:
				"Increase `--max-results` or narrow the command's output. The command already ran on this client; check its state before re-running anything that is not idempotent.",
			context: {
				id: device.id,
				identity: device.identity,
				requiredBytes,
				maxResultsBytes: budget,
				command: resolved.command,
				dispatched: true,
			},
		}),
	);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function notDispatched(
	code: "cmr/membership-changed" | "cmr/validation-incomplete",
	summary: string,
	context: Record<string, unknown>,
): CentrsError {
	return new CentrsError({
		code,
		summary,
		remediation:
			code === "cmr/membership-changed"
				? "Re-run to validate the current selection; a member is only run with the validation it passed."
				: "The command was not sent to this client. Check the controller and client are responsive, keep the command under ~60 KiB of `:parse` output, and retry.",
		context,
	});
}

function disconnectedError(device: CmrDevice, row: CmrScriptRow): CentrsError {
	return new CentrsError({
		code: "cmr/client-disconnected",
		summary: `CMR skipped ${device.identity}: ${row.output.trim() || "skipped"}. The command was not sent to it.`,
		remediation:
			"Check the client's `/cmr/client` status (`paired,connected`) and its route to the controller, then retry.",
		context: { id: device.id, identity: device.identity, output: row.output },
	});
}

function unknownOutcome(
	device: CmrDevice,
	cause: CentrsError | undefined,
	row: CmrScriptRow | undefined,
	why?: string,
): CentrsError {
	const reason =
		why ??
		(row && row.status === "failed"
			? `CMR reported \`${row.output.trim()}\``
			: cause
				? `the call ended with ${cause.code}`
				: "the call ended without a final status");
	return new CentrsError({
		code: "cmr/outcome-unknown",
		summary: `The command was sent to ${device.identity}, but its outcome is unknown: ${reason}. It may still be running.`,
		remediation:
			"CMR timeouts and cancellation do not stop a client script. Check the client's state before re-running anything that is not idempotent; centrs never retries it.",
		context: {
			id: device.id,
			identity: device.identity,
			...(row ? { lastStatus: row.status, output: row.output } : {}),
			...(cause ? { cause: cause.code } : {}),
		},
		...(cause ? { cause } : {}),
	});
}

function cancelledError(cause?: unknown): CentrsError {
	return new CentrsError({
		code: "cmr/cancelled",
		summary:
			"The operation was cancelled before the command was sent to this CMR client.",
		remediation: "Nothing ran on this client. Re-run when ready.",
		...(cause ? { cause } : {}),
	});
}

function internalUndecided(): CentrsError {
	return new CentrsError({
		code: "internal/unhandled",
		summary: "A CMR member finished without a recorded result.",
		remediation:
			"This is a centrs bug; report it with the command and labels used.",
	});
}

function isNoDevicesSelected(error: unknown): boolean {
	if (!(error instanceof CentrsError)) return false;
	const detail = error.context?.["detail"];
	return NO_DEVICES_SELECTED.test(
		`${error.summary} ${typeof detail === "string" ? detail : ""}`,
	);
}

/**
 * The per-member check before its call: `undefined` when the row still carries
 * the `.id` + `ids` the member was validated on, otherwise why it is not sent.
 * The original member set is fixed; a replacement row is never adopted, even
 * when it matches the labels. A host-side read is not atomic with the call:
 * a re-key inside that gap is still caught, after the fact, by S3.
 */
async function rebindBeforeSend(
	controller: CmrController,
	member: Member,
	signal: AbortSignal,
): Promise<CentrsError | undefined> {
	const device = member.device;
	let current: CmrDevice[];
	try {
		current = await readInventoryBeforeDispatch(controller, signal);
	} catch (error) {
		const cause = asCmrError(error);
		return new CentrsError({
			code: cause.code,
			summary: `The CMR inventory could not be re-read before sending to ${device.identity}, so the command was not sent to it: ${cause.summary}`,
			remediation:
				cause.remediation ??
				"Check the controller is reachable and responsive, then re-run.",
			context: { id: device.id, identity: device.identity, dispatched: false },
			cause,
		});
	}
	const now = current.find((d) => d.id === device.id);
	if (now && now.ids === device.ids) return undefined;
	return notDispatched(
		"cmr/membership-changed",
		`CMR device ${device.id} (${device.identity}) changed or left the inventory before its command was sent.`,
		{ before: device, after: now ?? null },
	);
}

/**
 * S1/S2: nothing has been sent yet, so a caller abort is `cmr/cancelled`
 * whether the read resolved or the adapter rejected because of it.
 */
async function readInventoryBeforeDispatch(
	controller: CmrController,
	signal: AbortSignal,
): Promise<CmrDevice[]> {
	if (signal.aborted) throw cancelledError();
	let devices: CmrDevice[];
	try {
		devices = await readInventory(controller);
	} catch (error) {
		if (signal.aborted) throw cancelledError(error);
		throw error;
	}
	if (signal.aborted) throw cancelledError();
	return devices;
}

async function readInventory(controller: CmrController): Promise<CmrDevice[]> {
	try {
		return await controller.devices();
	} catch (error) {
		const detail =
			error instanceof CentrsError ? error.context?.["detail"] : undefined;
		if (typeof detail === "string" && MISSING_MENU.test(detail)) {
			throw await noCmrError(controller, detail, error);
		}
		throw error;
	}
}

/** CMR first shipped in 7.26beta1 (manual; the quickchr CMR lab). */
const CMR_CONTROLLER: CapabilityRequirement = {
	capability: "cmr-controller",
	summary: "be a CMR controller (`/cmr` first shipped in 7.26beta1, a beta)",
	supported: [{ min: "7.26beta1" }],
	remediation:
		"Upgrade the controller to a RouterOS build with CMR (7.26beta1 or later), install the optional `cmr` package, and run `/cmr set enabled=yes`.",
};

/**
 * A missing `/cmr/device` has three causes, told apart only on this failure
 * path: RouterOS older than CMR (`routeros/version-unsupported`), or a 7.26+
 * router without the `cmr` package, possibly a CMR client.
 */
async function noCmrError(
	controller: CmrController,
	detail: string,
	cause: unknown,
): Promise<CentrsError> {
	const found = (await controller.absence?.().catch(() => undefined)) ?? {};
	if (found.version !== undefined) {
		try {
			assertCapability(CMR_CONTROLLER, {
				version: found.version,
				source: "live",
			});
		} catch (error) {
			return error as CentrsError;
		}
	}
	const client = found.controllerIdentity
		? ` It is a CMR client of ${found.controllerIdentity}${found.controllerAddress ? ` (${found.controllerAddress})` : ""}; point \`--cmr\` at that controller.`
		: "";
	return new CentrsError({
		code: "cmr/not-a-controller",
		summary:
			found.version !== undefined
				? `RouterOS ${found.version} supports CMR, but the target has no \`/cmr/device\`: the optional \`cmr\` package is not installed.${client}`
				: "The target did not answer `/cmr/device`; it is not a CMR controller.",
		remediation:
			"Point `--cmr` at the router running the optional `cmr` package (RouterOS 7.26beta1+) with `/cmr set enabled=yes`, or install that package on this router.",
		context: {
			detail,
			...(found.version !== undefined ? { version: found.version } : {}),
			...(found.controllerIdentity
				? {
						controllerIdentity: found.controllerIdentity,
						controllerAddress: found.controllerAddress,
					}
				: {}),
		},
		cause,
	});
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function memberError(
	member: Member,
	resolved: ResolvedExecuteRequest,
	error: CentrsError,
): ExecuteEnvelope {
	return {
		ok: false,
		error: serializeCentrsError(error),
		warnings: [],
		tips: [],
		meta: memberMeta(member, resolved),
	};
}

function memberMeta(
	member: Member,
	resolved: ResolvedExecuteRequest,
): ExecuteEnvelope["meta"] {
	const device = member.device;
	const target: EnvelopeTargetMeta = {
		input: device.identity,
		identity: device.identity,
		cmr: {
			id: device.id,
			deviceKey: device.ids.split("/")[0] || undefined,
			address: device.address,
		},
	};
	return {
		target,
		via: resolved.via.value,
		settings: settingsMeta(resolved),
		validation: member.validation,
		operation: {
			kind: "execute",
			objectCount: 1,
			request: requestSummary(resolved),
			auth: {
				username: resolved.auth.username,
				passwordProvided: resolved.auth.passwordProvided,
			},
		},
	};
}

function devicePassed(
	resolved: ResolvedExecuteRequest,
	offline: OfflineGateResult | undefined,
): EnvelopeValidationMeta {
	return {
		enabled: true,
		source: CMR_VALIDATION_SOURCE,
		result: "passed",
		syntax: true,
		...(resolved.canonical.mode === "structured" ? { semantic: true } : {}),
		stages: passedStages(
			offline ?? { verdict: "pass", warnings: [] },
			CMR_VALIDATION_SOURCE,
		),
	};
}

function deviceRejected(
	resolved: ResolvedExecuteRequest,
	offline: OfflineGateResult | undefined,
	error: CentrsError,
): EnvelopeValidationMeta {
	const structured = resolved.canonical.mode === "structured";
	const nameRejected =
		structured && error.code === "validation/unknown-attribute";
	return {
		enabled: true,
		source: CMR_VALIDATION_SOURCE,
		result: "failed",
		...(nameRejected ? { syntax: true, semantic: false } : { syntax: false }),
		stages: [
			offlineStagePassed(offline?.verdict),
			{ stage: "device", source: CMR_VALIDATION_SOURCE, result: "failed" },
		],
	};
}

function deviceNotReached(
	resolved: ResolvedExecuteRequest,
	offline: OfflineGateResult | undefined,
	code: string,
): EnvelopeValidationMeta {
	if (!resolved.validate.value) return disabledValidationMeta();
	return {
		enabled: true,
		source: CMR_VALIDATION_SOURCE,
		stages: [
			offlineStagePassed(offline?.verdict),
			{
				stage: "device",
				source: CMR_VALIDATION_SOURCE,
				result: "skipped",
				reason: notReachedReason(code),
			},
		],
	};
}

function controllerTargetMeta(
	resolved: ResolvedExecuteRequest,
): EnvelopeTargetMeta {
	const target = resolved.target;
	return {
		input: target.input,
		host: target.host,
		port: target.port,
		baseUrl: target.baseUrl,
		identity: target.identity,
		recordIndex: target.recordIndex,
		source: toCoreSource(target.source),
	};
}

function settingsMeta(resolved: ResolvedExecuteRequest): CommonSettingsMeta {
	return {
		via: toCoreSource(resolved.via.source),
		host: toCoreSource(resolved.target.hostSource),
		port: toCoreSource(resolved.target.portSource),
		timeoutMs: toCoreSource(resolved.timeoutMs.source),
		format: toCoreSource(resolved.format.source),
		validate: toCoreSource(resolved.validate.source),
		username: resolved.auth.usernameSource
			? toCoreSource(resolved.auth.usernameSource)
			: undefined,
		password: resolved.auth.passwordSource
			? toCoreSource(resolved.auth.passwordSource)
			: undefined,
	};
}

function requestSummary(
	resolved: ResolvedExecuteRequest,
): ExecuteRequestSummary {
	return {
		command: resolved.command,
		canonical: resolved.canonical,
		write: isWriteShaped(resolved.canonical),
		yes: resolved.yes,
		validate: resolved.validate.value,
		verbose: resolved.verbose,
		timeoutMs: resolved.timeoutMs.value,
		format: resolved.format.value,
		maxResultsBytes: resolved.maxResultsBytes?.value,
	};
}

async function confirmCmrWrite(
	request: ExecuteCmrRequest,
	signal: AbortSignal,
	resolved: ResolvedExecuteRequest,
	controllerName: string,
	runnable: number,
	excluded: number,
	notEnforced: Warning | undefined,
): Promise<void> {
	if (resolved.yes) return;
	const scope = `${runnable} CMR client(s) via controller ${controllerName}${excluded > 0 ? ` (${excluded} excluded)` : ""}`;
	const policyNote = notEnforced ? ` ${notEnforced.message}` : "";
	if (request.stdinIsTty ?? process.stdin.isTTY) {
		// The prompt reads stdin and cannot see `signal`, so race it: a cancel at
		// the prompt returns here and the dispatch loop reports every member
		// `cmr/cancelled` without sending anything.
		const cancelled = new Promise<false>((resolve) => {
			if (signal.aborted) resolve(false);
			signal.addEventListener("abort", () => resolve(false), { once: true });
		});
		const confirmed = await Promise.race([
			(request.confirm ?? promptForWriteConfirmation)(
				`Run write-shaped \`${resolved.command}\` on ${scope}?${policyNote} Type yes to continue: `,
			),
			cancelled,
		]);
		if (confirmed || signal.aborted) return;
	}
	throw new CentrsError({
		code: "usage/confirmation-required",
		summary: `A write-shaped \`${resolved.command}\` would run on ${scope} and needs explicit confirmation.${policyNote}`,
		remediation:
			"Pass `--yes` after reviewing the selection, or answer `yes` at the TTY prompt. Clients that failed validation are never sent the command.",
		context: {
			command: resolved.command,
			routers: runnable,
			excluded,
			controller: controllerName,
			...(notEnforced ? { callerPolicy: notEnforced.context } : {}),
		},
	});
}

function defaultNonce(): string {
	return `centrs-cmr-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Production controller: one protocol adapter to the controller
// ---------------------------------------------------------------------------

function adapterController(
	resolved: ResolvedExecuteRequest,
	signal: AbortSignal,
): CmrController {
	const via = resolved.via.value;
	const config = (timeoutMs: number, signal?: AbortSignal) => ({
		protocol: via,
		host: resolved.target.host,
		port: resolved.target.port,
		tls: resolved.target.tls,
		baseUrl: resolved.target.baseUrl,
		username: resolved.auth.username,
		password: resolved.auth.password,
		timeoutMs,
		insecure: resolved.insecure.value,
		signal,
	});
	// Native: one session for every call (concurrent tagged commands).
	// REST: an adapter per call, so each carries its own deadline signal.
	const shared: ProtocolAdapter = createProtocolAdapter(
		config(resolved.timeoutMs.value, signal),
	);
	return {
		async devices() {
			const result = await shared.apiRequest({
				verb: "print",
				path: "/cmr/device",
			});
			const rows = Array.isArray(result.data)
				? (result.data as Record<string, string>[])
				: [];
			return rows.map((row) => ({
				id: row[".id"] ?? "",
				ids: row["ids"] ?? "",
				identity: row["identity"] ?? "",
				address: row["address"] || undefined,
			}));
		},
		runScript(call, signal) {
			return via === "native-api"
				? nativeRunScript(shared, call, signal)
				: restRunScript(
						(ms, s) => createProtocolAdapter(config(ms, s)),
						call,
						signal,
					);
		},
		async absence() {
			const version = await probeDeviceVersion(shared).catch(() => undefined);
			const client = (await shared
				.getSingleton("/cmr/client")
				.catch(() => undefined)) as Record<string, string> | undefined;
			return {
				version: version?.version,
				controllerIdentity: client?.["controller-identity"] || undefined,
				controllerAddress: client?.["controller-address"] || undefined,
			};
		},
		callerPolicy: () =>
			resolved.auth.username
				? readCmrCallerPolicy(shared, resolved.auth.username)
				: Promise.resolve(undefined),
		close: () => shared.close(),
	};
}

function runScriptAttributes(call: CmrScriptCall): Record<string, string> {
	return {
		numbers: call.numbers,
		labels: call.labels,
		script: call.script,
		timeout: `${Math.max(1, Math.ceil(call.timeoutMs / 1000))}s`,
		...RUN_SCRIPT_PINNED,
	};
}

function toRow(attributes: Record<string, string>): CmrScriptRow {
	return {
		device: attributes["device"] ?? "",
		status: attributes["status"] ?? "",
		output: attributes["output"] ?? "",
		section: Number(attributes[".section"] ?? 0),
	};
}

function newer(
	current: CmrScriptRow | undefined,
	next: CmrScriptRow,
): CmrScriptRow {
	return current && current.section > next.section ? current : next;
}

function deadlineSignal(signal: AbortSignal, call: CmrScriptCall): AbortSignal {
	return AbortSignal.any([
		signal,
		AbortSignal.timeout(call.timeoutMs + CMR_CALL_GRACE_MS),
	]);
}

async function nativeRunScript(
	adapter: ProtocolAdapter,
	call: CmrScriptCall,
	outer: AbortSignal,
): Promise<CmrScriptOutcome> {
	const signal = deadlineSignal(outer, call);
	let sent = false;
	let row: CmrScriptRow | undefined;
	try {
		for await (const reply of adapter.stream(
			{
				verb: "run",
				path: CMR_RUN_SCRIPT_PATH,
				attributes: runScriptAttributes(call),
			},
			{
				signal,
				cancelGraceMs: CMR_CALL_GRACE_MS,
				onListening: () => {
					sent = true;
				},
			},
		)) {
			if (reply.type === "re") row = newer(row, toRow(reply.attributes));
		}
	} catch (error) {
		if (isNoDevicesSelected(error)) return { selected: false, sent: false };
		return { selected: true, sent, row, error: asCmrError(error) };
	}
	if (signal.aborted && !(row && FINAL_STATUSES.has(row.status))) {
		return { selected: true, sent, row, error: abortError(outer, call) };
	}
	return { selected: true, sent, row };
}

async function restRunScript(
	adapterFor: (timeoutMs: number, signal: AbortSignal) => ProtocolAdapter,
	call: CmrScriptCall,
	outer: AbortSignal,
): Promise<CmrScriptOutcome> {
	if (outer.aborted)
		return { selected: true, sent: false, error: cancelledError() };
	const signal = deadlineSignal(outer, call);
	const adapter = adapterFor(call.timeoutMs + CMR_CALL_GRACE_MS, signal);
	try {
		const result = await adapter.apiRequest({
			verb: "run",
			path: CMR_RUN_SCRIPT_PATH,
			attributes: runScriptAttributes(call),
		});
		let row: CmrScriptRow | undefined;
		for (const attributes of Array.isArray(result.data)
			? (result.data as Record<string, string>[])
			: []) {
			row = newer(row, toRow(attributes));
		}
		return { selected: true, sent: true, row };
	} catch (error) {
		if (isNoDevicesSelected(error)) return { selected: false, sent: false };
		const mapped = signal.aborted ? abortError(outer, call) : asCmrError(error);
		// REST cannot say whether a failed request reached RouterOS, except when
		// the connection itself never opened.
		const neverOpened = NOT_SENT_TRANSPORT_CODES.includes(mapped.code);
		return { selected: true, sent: !neverOpened, error: mapped };
	} finally {
		await adapter.close();
	}
}

function abortError(outer: AbortSignal, call: CmrScriptCall): CentrsError {
	if (outer.aborted) {
		return new CentrsError({
			code: "cmr/cancelled",
			summary: "The CMR call was cancelled.",
			remediation:
				"Cancellation does not stop a client script that already started.",
		});
	}
	return new CentrsError({
		code: "transport/timeout",
		summary: `The controller gave no final status within ${call.timeoutMs + CMR_CALL_GRACE_MS} ms.`,
		remediation: "Raise `--timeout` (CMR caps one call at ~60 s).",
		context: { timeoutMs: call.timeoutMs, graceMs: CMR_CALL_GRACE_MS },
	});
}

function asCmrError(error: unknown): CentrsError {
	return error instanceof CentrsError
		? error
		: new CentrsError({
				code: "internal/unhandled",
				summary: "A CMR controller call failed unexpectedly.",
				remediation:
					"Re-run with `--format json` to capture the structured cause.",
				cause: error,
			});
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Outer error envelope for a CMR run that failed before any member result. */
export function buildExecuteCmrErrorEnvelope(
	request: Pick<ExecuteRequest, "targetInput" | "via">,
	error: unknown,
): ExecuteCmrErrorEnvelope {
	const centrsError = asCmrError(error);
	const via =
		request.via === "rest-api" || request.via === "native-api"
			? (request.via as RouterOsProtocol)
			: null;
	return {
		ok: false,
		error: serializeCentrsError(centrsError),
		warnings: OUTER_ERROR_WARNINGS.get(centrsError) ?? [],
		tips: [],
		meta: {
			target: { input: redactTargetInput(request.targetInput) },
			via,
			settings: {},
		},
	};
}

/** Text: a summary line, then each member's status and (indented) output. */
export function renderExecuteCmrEnvelope(
	envelope: ExecuteCmrEnvelope | ExecuteCmrErrorEnvelope,
	format: "json" | "yaml" | "text",
	options: { verbose?: boolean } = {},
): string {
	if (format === "json") return JSON.stringify(envelope, null, 2);
	if (format === "yaml") return toYaml(envelope);
	if (!envelope.ok) return formatCentrsErrorText(envelope.error, options);
	const operation = envelope.meta.operation;
	const { total, ok, failed } = envelope.data.summary;
	const controller =
		envelope.meta.target.identity ??
		envelope.meta.target.input ??
		envelope.meta.target.host ??
		"?";
	const lines = [
		terminalSafeLine(
			`execute --cmr ${operation?.cmr.labels ?? "?"} via ${controller}: ${ok}/${total} ok, ${failed} failed`,
		),
	];
	for (const target of envelope.data.targets) {
		const id = target.meta.target.cmr?.id ?? "-";
		const label = target.meta.target.identity ?? "(unknown)";
		if (target.ok) {
			lines.push(terminalSafeLine(`  [${id}] ok    ${label}`));
			const ret = (target.data as { ret?: string }).ret ?? "";
			for (const line of ret
				.replaceAll("\r\n", "\n")
				.replace(/\n+$/, "")
				.split("\n")) {
				if (line.length > 0) lines.push(terminalSafeLine(`        ${line}`));
			}
		} else {
			lines.push(
				terminalSafeLine(
					`  [${id}] FAIL  ${label} [${target.error.code}] ${target.error.summary}`,
				),
			);
			if (options.verbose && target.error.remediation) {
				lines.push(
					terminalSafeLine(`        Fix: ${target.error.remediation}`),
				);
			}
		}
		for (const warning of target.warnings) {
			lines.push(
				terminalSafeLine(
					`        warning [${warning.code}]: ${warning.message}`,
				),
			);
		}
	}
	for (const warning of envelope.warnings) {
		lines.push(
			terminalSafeLine(`warning [${warning.code}]: ${warning.message}`),
		);
	}
	return lines.join("\n");
}
