import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveApiRequest } from "../../src/api.ts";
import { fanoutExitCode } from "../../src/core/fanout.ts";
import { CentrsError } from "../../src/errors.ts";
import { resolveExecuteRequest } from "../../src/execute.ts";
import {
	CMR_VALIDATION_SOURCE,
	type CmrController,
	type CmrDevice,
	type CmrScriptCall,
	type CmrScriptOutcome,
	type ExecuteCmrRequest,
	executeCmr,
} from "../../src/execute-cmr.ts";
import { classifyParseResult } from "../../src/protocols/mac-telnet-console.ts";
import { runCliCaptured as run } from "./cli-capture.ts";

/**
 * `execute --cmr` (#450) against an injected controller. The device behaviour
 * the fake reproduces (one row per single-device call, `no devices selected`
 * for a non-member, `...(+N B)` clipping, timeouts that leave the script
 * running) is grounded on 7.26beta1 and re-asserted live in
 * `test/integration/execute-cmr.test.ts`.
 */

const NONCE = "centrs-cmr-test";
const CTL: CmrDevice = { id: "*1", ids: "AAAA/CCCC", identity: "ctl" };
const C1: CmrDevice = {
	id: "*2",
	ids: "BBBB/CCCC",
	identity: "c1",
	address: "192.0.2.2",
};
const C3: CmrDevice = {
	id: "*3",
	ids: "DDDD/CCCC",
	identity: "c3",
	address: "192.0.2.3",
};

type Script = (call: CmrScriptCall) => CmrScriptOutcome;

const row = (status: string, output: string) => ({
	selected: true,
	sent: true,
	row: { device: "x", status, output, section: 1 },
});
const notSelected: CmrScriptOutcome = { selected: false, sent: false };
const accepted = (il = "(evl /system/identity/print)") =>
	row("success", `${il}\r\n${NONCE}\r\n`);

interface Fake {
	controller: CmrController;
	preflight: CmrScriptCall[];
	dispatch: CmrScriptCall[];
	closed: boolean;
}

/** `inventory` is returned per read (S1, S2, S3…); the last one repeats. */
function fake(options: {
	/** One entry per read (S1, S2, S3…); the last repeats. An error is thrown. */
	inventory: Array<CmrDevice[] | CentrsError>;
	preflight?: Record<string, CmrScriptOutcome>;
	dispatch?: Record<string, CmrScriptOutcome | Script>;
	onDispatch?: () => void;
	/** Called with the 0-based read number before each inventory read. */
	onRead?: (read: number) => void;
}): Fake {
	const state: Fake = {
		preflight: [],
		dispatch: [],
		closed: false,
	} as unknown as Fake;
	let reads = 0;
	state.controller = {
		async devices() {
			options.onRead?.(reads);
			const snapshot =
				options.inventory[Math.min(reads, options.inventory.length - 1)] ?? [];
			reads += 1;
			if (snapshot instanceof CentrsError) throw snapshot;
			return snapshot;
		},
		async runScript(call) {
			if (call.script.includes(NONCE)) {
				state.preflight.push(call);
				return options.preflight?.[call.numbers] ?? accepted();
			}
			state.dispatch.push(call);
			options.onDispatch?.();
			const answer =
				options.dispatch?.[call.numbers] ?? row("success", "ok\r\n");
			return typeof answer === "function" ? answer(call) : answer;
		},
		async close() {
			state.closed = true;
		},
	};
	return state;
}

function request(
	overrides: Partial<ExecuteCmrRequest> = {},
): ExecuteCmrRequest {
	return {
		targetInput: "192.0.2.1",
		via: "native-api",
		command: "/system/identity/print",
		labels: "lab",
		stdinIsTty: false,
		...overrides,
	};
}

async function runFake(f: Fake, overrides: Partial<ExecuteCmrRequest> = {}) {
	return executeCmr(
		request(overrides),
		{ CENTRS_SKIP_ENV_FILE: "1" },
		{
			controller: () => f.controller,
			nonce: () => NONCE,
		},
	);
}

function codes(envelope: {
	data: {
		targets: readonly ({ ok: true } | { ok: false; error: { code: string } })[];
	};
}): string[] {
	return envelope.data.targets.map((t) => (t.ok ? "ok" : t.error.code));
}

async function rejection(promise: Promise<unknown>): Promise<CentrsError> {
	try {
		await promise;
	} catch (error) {
		return error as CentrsError;
	}
	throw new Error("expected a rejection");
}

describe("execute --cmr: selection and binding", () => {
	test("one preflight call per inventory row and one dispatch per member, by .id", async () => {
		const f = fake({
			inventory: [[CTL, C1, C3]],
			preflight: { "*3": notSelected },
			dispatch: {
				"*1": row("success", "ctl\r\n"),
				"*2": row("success", "c1\r\n"),
			},
		});
		const envelope = await runFake(f);

		expect(f.preflight.map((c) => c.numbers)).toEqual(["*1", "*2", "*3"]);
		expect(f.preflight.every((c) => c.labels === "lab")).toBe(true);
		expect(f.preflight[0]?.script).toBe(
			`:put [:parse "/system/identity/print"]; :put "${NONCE}"`,
		);
		expect(f.dispatch.map((c) => [c.numbers, c.labels, c.script])).toEqual([
			["*1", "lab", "/system/identity/print"],
			["*2", "lab", "/system/identity/print"],
		]);
		expect(envelope.data.summary).toEqual({ total: 2, ok: 2, failed: 0 });
		expect(envelope.meta.operation?.cmr).toEqual({
			labels: "lab",
			inventory: 3,
			selected: 2,
			dispatched: 2,
		});
		const [first, second] = envelope.data.targets;
		expect(first?.ok && first.data).toEqual({ ret: "ctl\r\n" });
		expect(second?.meta.target).toMatchObject({
			identity: "c1",
			cmr: {
				controller: "192.0.2.1",
				id: "*2",
				deviceKey: "BBBB",
				address: "192.0.2.2",
			},
		});
		expect(second?.meta.validation).toMatchObject({
			source: CMR_VALIDATION_SOURCE,
			result: "passed",
			syntax: true,
			semantic: true,
		});
		expect(f.closed).toBe(true);
		expect(fanoutExitCode(envelope)).toBe(0);
	});

	test("a preflight call with no answer makes the whole selection incomplete; nothing is dispatched", async () => {
		const f = fake({
			inventory: [[CTL, C1]],
			preflight: {
				"*2": {
					selected: true,
					sent: true,
					error: new CentrsError({ code: "transport/timeout", summary: "t" }),
				},
			},
		});
		const error = await rejection(runFake(f));
		expect(error.code).toBe("cmr/selection-incomplete");
		expect(f.dispatch).toEqual([]);
	});

	test("a member whose ids changed between validation and dispatch is not sent the command", async () => {
		const f = fake({
			inventory: [
				[CTL, C1],
				[CTL, { ...C1, ids: "EEEE/CCCC" }],
			],
		});
		const envelope = await runFake(f);
		expect(f.dispatch.map((c) => c.numbers)).toEqual(["*1"]);
		expect(envelope.data.targets[1]).toMatchObject({
			ok: false,
			error: { code: "cmr/membership-changed" },
		});
		expect(fanoutExitCode(envelope)).toBe(2);
	});

	test("an empty selection is success with a warning, not an error", async () => {
		const f = fake({
			inventory: [[CTL, C1]],
			preflight: { "*1": notSelected, "*2": notSelected },
		});
		const envelope = await runFake(f);
		expect(envelope.data.summary.total).toBe(0);
		expect(envelope.warnings.map((w) => w.code)).toContain(
			"cmr/empty-selection",
		);
		expect(fanoutExitCode(envelope)).toBe(0);
	});

	// The two ways a missing `/cmr/device` arrives (7.24.5 CHR, no `cmr` package).
	const missingMenu: Array<[string, CentrsError]> = [
		[
			"native-api",
			new CentrsError({
				code: "routeros/unknown-path",
				summary: "x",
				context: { detail: "no such command prefix" },
			}),
		],
		[
			"rest-api",
			new CentrsError({
				code: "routeros/request-failed",
				summary: "x",
				context: { detail: "no such command or directory (cmr)" },
			}),
		],
	];
	for (const [via, error] of missingMenu) {
		test(`a missing /cmr/device (${via}) is named as not a controller`, async () => {
			const f = fake({ inventory: [error] });
			expect((await rejection(runFake(f))).code).toBe("cmr/not-a-controller");
		});
	}

	test("any other inventory failure (e.g. permissions) propagates unchanged", async () => {
		const f = fake({
			inventory: [
				new CentrsError({
					code: "routeros/command-failed",
					summary: "x",
					context: { detail: "not enough permissions (9)" },
				}),
			],
		});
		expect((await rejection(runFake(f))).code).toBe("routeros/command-failed");
	});

	test("an inventory that cannot be re-read after dispatch leaves sent results unknown", async () => {
		const unreadable = new CentrsError({
			code: "transport/timeout",
			summary: "t",
		});
		// S1, S2, one re-bind read per member, then S3.
		const f = fake({
			inventory: [[CTL, C1], [CTL, C1], [CTL, C1], [CTL, C1], unreadable],
		});
		const envelope = await runFake(f);
		expect(f.dispatch.length).toBe(2);
		expect(codes(envelope)).toEqual([
			"cmr/outcome-unknown",
			"cmr/outcome-unknown",
		]);
	});

	test("a key change after dispatch makes even a runtime failure unknown; a CMR skip stays a skip", async () => {
		const f = fake({
			inventory: [
				[CTL, C1],
				[CTL, C1],
				[CTL, C1],
				[CTL, C1],
				[
					{ ...CTL, ids: "9999/CCCC" },
					{ ...C1, ids: "EEEE/CCCC" },
				],
			],
			dispatch: {
				"*1": row("failed", "no such item (/interface/set; line 1)\n"),
				"*2": row("skipped", "disconnected"),
			},
		});
		const envelope = await runFake(f);
		expect(codes(envelope)).toEqual([
			"cmr/outcome-unknown",
			"cmr/client-disconnected",
		]);
	});

	test("cancelling while the pre-dispatch inventory is read sends nothing", async () => {
		const abort = new AbortController();
		const f = fake({
			inventory: [[CTL, C1]],
			onRead: (read) => {
				if (read === 1) abort.abort();
			},
		});
		const error = await rejection(runFake(f, { signal: abort.signal }));
		expect(error.code).toBe("cmr/cancelled");
		expect(f.dispatch).toEqual([]);
	});

	// Production adapters REJECT when the caller aborts mid-read; the fake above
	// resolves. Both S1 and S2 must still say cancelled, not transport.
	for (const [phase, read] of [
		["S1", 0],
		["S2", 1],
	] as const) {
		test(`an inventory read the abort makes reject (${phase}) is cmr/cancelled, not a transport fault`, async () => {
			const abort = new AbortController();
			let reads = 0;
			const f = fake({ inventory: [[CTL, C1]] });
			const devices = f.controller.devices.bind(f.controller);
			f.controller.devices = async () => {
				if (reads++ === read) {
					abort.abort();
					throw new CentrsError({
						code: "transport/network",
						summary: "Network request to 192.0.2.1 failed.",
					});
				}
				return devices();
			};
			const error = await rejection(runFake(f, { signal: abort.signal }));
			expect(error.code).toBe("cmr/cancelled");
			expect(f.preflight.length).toBe(read === 0 ? 0 : 2);
			expect(f.dispatch).toEqual([]);
		});
	}

	test("a client replaced while the write prompt waits is never sent the command", async () => {
		const inventory: Array<CmrDevice[]> = [[CTL, C1]];
		const f = fake({ inventory });
		const envelope = await runFake(f, {
			command: '/system/note/set note="review"',
			stdinIsTty: true,
			confirm: async () => {
				inventory.push([CTL, { ...C1, ids: "EEEE/CCCC" }]);
				return true;
			},
		});
		expect(f.dispatch.map((c) => c.numbers)).toEqual(["*1"]);
		expect(codes(envelope)).toEqual(["ok", "cmr/membership-changed"]);
		expect(envelope.data.targets[1]).toMatchObject({
			error: { context: { after: { ids: "EEEE/CCCC" } } },
		});
		expect(envelope.meta.operation?.cmr.dispatched).toBe(1);
	});

	test("a client replaced while queued behind the pool is never sent the command", async () => {
		const inventory: Array<CmrDevice[]> = [[CTL, C1, C3]];
		const f = fake({
			inventory,
			onDispatch: () => {
				if (inventory.length === 1) inventory.push([CTL, C1]); // C3 left
			},
		});
		const envelope = await runFake(f, { concurrency: 1 });
		expect(f.dispatch.map((c) => c.numbers)).toEqual(["*1", "*2"]);
		expect(codes(envelope)).toEqual(["ok", "ok", "cmr/membership-changed"]);
		expect(envelope.data.targets[2]).toMatchObject({
			error: { context: { after: null } },
		});
	});

	test("cancelling during a member's re-bind read sends nothing to it", async () => {
		const abort = new AbortController();
		let reads = 0;
		const f = fake({ inventory: [[C1]] });
		const devices = f.controller.devices.bind(f.controller);
		f.controller.devices = async () => {
			if (reads++ === 2) {
				abort.abort();
				throw new CentrsError({ code: "transport/network", summary: "n" });
			}
			return devices();
		};
		const envelope = await runFake(f, { signal: abort.signal });
		expect(f.dispatch).toEqual([]);
		expect(envelope.data.targets[0]).toMatchObject({
			ok: false,
			error: { code: "cmr/cancelled", context: { dispatched: false } },
		});
	});

	test("a re-bind read that fails sends nothing to that member and says so", async () => {
		const f = fake({
			inventory: [
				[C1],
				[C1],
				new CentrsError({ code: "transport/timeout", summary: "t" }),
			],
		});
		const envelope = await runFake(f);
		expect(f.dispatch).toEqual([]);
		expect(envelope.data.targets[0]).toMatchObject({
			ok: false,
			error: {
				code: "transport/timeout",
				context: { dispatched: false },
			},
		});
	});
});

describe("execute --cmr: client validation completeness", () => {
	test("the classifier alone accepts empty and clipped text, which is why completeness is gated first", () => {
		expect(() => classifyParseResult("", "/x")).not.toThrow();
		expect(() =>
			classifyParseResult("(evl /putmessage=xxx...(+597 B)", "/x"),
		).not.toThrow();
	});

	// Each case names the reason it must be refused for, so a guard that only
	// passes because a later guard catches the same fixture shows up as red.
	const incomplete: Array<[string, CmrScriptOutcome, string]> = [
		["empty output", row("success", ""), "completion marker missing"],
		["nonce only", row("success", `${NONCE}\r\n`), "empty `:parse` return"],
		[
			"clipped by CMR",
			row("success", `(evl /putmessage=xxxx\n...(+597 B)`),
			"output clipped",
		],
		[
			// Two IL lines and no nonce: without the marker check the first line
			// would pass as a complete, accepted parse.
			"missing completion marker",
			row("success", "(evl /system/identity/print)\r\n(evl /x)\r\n"),
			"completion marker missing",
		],
		["last row still running", row("running", ""), "last status running"],
		["not IL", row("success", `hello\r\n${NONCE}\r\n`), "not IL"],
		[
			"parenthesized but not IL",
			row("success", `(not IL)\r\n${NONCE}\r\n`),
			"not IL",
		],
		["comment-only parse (`/`)", row("success", `/\r\n${NONCE}\r\n`), "not IL"],
		[
			"validation call failed",
			row("failed", "std failure: timeout (13)"),
			"status failed",
		],
	];
	for (const [name, outcome, reason] of incomplete) {
		test(`${name} → cmr/validation-incomplete (${reason}), not dispatched`, async () => {
			const f = fake({ inventory: [[CTL, C1]], preflight: { "*2": outcome } });
			const envelope = await runFake(f);
			expect(f.dispatch.map((c) => c.numbers)).toEqual(["*1"]);
			const target = envelope.data.targets[1];
			expect(target).toMatchObject({
				ok: false,
				error: { code: "cmr/validation-incomplete" },
				meta: {
					validation: {
						stages: [
							{ stage: "offline", result: "passed" },
							{ stage: "device", result: "skipped" },
						],
					},
				},
			});
			expect(target?.ok === false && target.error.summary).toContain(reason);
		});
	}

	test("a client-side :parse rejection fails that member only", async () => {
		const f = fake({
			inventory: [[CTL, C1]],
			preflight: {
				"*2": row("success", `syntax error (line 1 column 12)\r\n${NONCE}\r\n`),
			},
		});
		const envelope = await runFake(f, { command: "/cmr/device/print" });
		expect(f.dispatch.map((c) => c.numbers)).toEqual(["*1"]);
		expect(envelope.data.targets[1]).toMatchObject({
			ok: false,
			// The client lacks the `cmr` package, and the absent-menu table names it.
			error: { code: "validation/package-missing" },
			meta: { validation: { result: "failed", source: CMR_VALIDATION_SOURCE } },
		});
	});

	test("an unknown attribute on the client is validation/unknown-attribute", async () => {
		const f = fake({
			inventory: [[C1]],
			preflight: {
				"*2": row(
					"success",
					`(evl bad parameter foo (line 1 column 24) /ip/address/add)\r\n${NONCE}\r\n`,
				),
			},
		});
		const envelope = await runFake(f, {
			command: "/ip/address/add foo=bar",
			yes: true,
		});
		expect(envelope.data.targets[0]).toMatchObject({
			ok: false,
			error: { code: "validation/unknown-attribute" },
			meta: { validation: { syntax: true, semantic: false } },
		});
		expect(f.dispatch).toEqual([]);
	});

	test("--no-validate still proves membership and liveness, with validation reported disabled", async () => {
		const f = fake({
			inventory: [[C1]],
			preflight: { "*2": row("success", `${NONCE}\r\n`) },
		});
		const envelope = await runFake(f, { validate: false });
		expect(f.preflight[0]?.script).toBe(`:put "${NONCE}"`);
		expect(envelope.data.targets[0]).toMatchObject({
			ok: true,
			meta: { validation: { enabled: false } },
		});
	});
});

describe("execute --cmr: dispatch outcomes", () => {
	const cases: Array<[string, CmrScriptOutcome, string]> = [
		["CMR timeout", row("failed", "timed out (6)"), "cmr/outcome-unknown"],
		[
			"CMR 60 s ceiling",
			row("failed", "std failure: timeout (13)"),
			"cmr/outcome-unknown",
		],
		[
			"runtime error",
			row("failed", "no such item (/interface/set; line 1)\n"),
			"routeros/",
		],
		["skipped", row("skipped", "disconnected"), "cmr/client-disconnected"],
		[
			"policy the CMR script lacks",
			row("failed", "not enough permissions (9) (/user/add; line 1)\n"),
			"cmr/policy-denied",
		],
		[
			"sent, no final row",
			{
				selected: true,
				sent: true,
				row: { device: "c1", status: "running", output: "", section: 3 },
			},
			"cmr/outcome-unknown",
		],
		[
			"sent, call lost",
			{
				selected: true,
				sent: true,
				error: new CentrsError({
					code: "transport/connection-closed",
					summary: "closed",
				}),
			},
			"cmr/outcome-unknown",
		],
		["left the labels", notSelected, "cmr/membership-changed"],
		[
			"never sent",
			{
				selected: true,
				sent: false,
				error: new CentrsError({
					code: "transport/connection-refused",
					summary: "refused",
				}),
			},
			"transport/connection-refused",
		],
	];
	for (const [name, outcome, code] of cases) {
		test(`${name} → ${code}`, async () => {
			const f = fake({ inventory: [[C1]], dispatch: { "*2": outcome } });
			const envelope = await runFake(f);
			const target = envelope.data.targets[0];
			expect(target?.ok).toBe(false);
			expect(target?.ok === false && target.error.code.startsWith(code)).toBe(
				true,
			);
			expect(f.dispatch.length).toBe(1);
		});
	}

	test("a write is dispatched exactly once even when the call is lost (no retry)", async () => {
		const f = fake({
			inventory: [[C1]],
			dispatch: {
				"*2": {
					selected: true,
					sent: true,
					error: new CentrsError({
						code: "transport/network",
						summary: "reset",
					}),
				},
			},
		});
		const envelope = await runFake(f, {
			command: "/ip/address/add address=192.0.2.9/32 interface=ether1",
			yes: true,
		});
		expect(f.dispatch.length).toBe(1);
		expect(envelope.data.targets[0]).toMatchObject({
			ok: false,
			error: { code: "cmr/outcome-unknown" },
		});
	});

	test("clipped command output is success with a truncation warning", async () => {
		const f = fake({
			inventory: [[C1]],
			dispatch: { "*2": row("success", "aaaa\n...(+597 B)") },
		});
		const envelope = await runFake(f);
		const target = envelope.data.targets[0];
		expect(target?.ok).toBe(true);
		expect(target?.warnings.map((w) => w.code)).toEqual([
			"cmr/output-truncated",
		]);
		expect(target?.meta.truncated).toMatchObject({ truncated: true });
	});

	test("--max-results is enforced per member in UTF-8 bytes; the error says the command ran", async () => {
		const output = `${"é".repeat(1_000)}\r\n`;
		const dispatch = { "*2": row("success", output) };
		const unbounded = await runFake(fake({ inventory: [[C1]], dispatch }), {
			format: "json",
		});
		const rendered = JSON.stringify(unbounded.data.targets[0], null, 2);
		const bytes = new TextEncoder().encode(rendered).length;
		// Between the character count and the byte count: only UTF-8 counting trips.
		const budget = Math.floor((rendered.length + bytes) / 2);
		expect(rendered.length).toBeLessThan(budget);

		const f = fake({ inventory: [[C1]], dispatch });
		const envelope = await runFake(f, {
			format: "json",
			maxResultsBytes: budget,
		});
		expect(f.dispatch.length).toBe(1);
		expect(envelope.data.targets[0]).toMatchObject({
			ok: false,
			error: {
				code: "input/max-results-exceeded",
				context: { maxResultsBytes: budget, dispatched: true },
			},
		});
		expect(JSON.stringify(envelope)).not.toContain("é".repeat(100));

		const roomy = await runFake(fake({ inventory: [[C1]], dispatch }), {
			format: "json",
			// The budget itself is echoed in meta, so leave room for that field.
			maxResultsBytes: bytes + 64,
		});
		expect(codes(roomy)).toEqual(["ok"]);
	});

	test("a key change seen after dispatch turns a success into an unknown outcome", async () => {
		const f = fake({
			inventory: [[C1], [C1], [C1], [{ ...C1, ids: "FFFF/CCCC" }]],
		});
		const envelope = await runFake(f);
		expect(envelope.data.targets[0]).toMatchObject({
			ok: false,
			error: { code: "cmr/outcome-unknown" },
		});
	});
});

describe("execute --cmr: write gate and cancellation", () => {
	test("a write without --yes is refused before dispatch, naming the count and the excluded", async () => {
		const f = fake({
			inventory: [[CTL, C1]],
			preflight: {
				"*2": row("success", `syntax error (line 1 column 3)\r\n${NONCE}\r\n`),
			},
		});
		const error = await rejection(
			runFake(f, {
				command: "/ip/address/add address=192.0.2.9/32 interface=ether1",
			}),
		);
		expect(error.code).toBe("usage/confirmation-required");
		expect(error.context).toMatchObject({ routers: 1, excluded: 1 });
		expect(f.dispatch).toEqual([]);
	});

	test("cancelling at the write prompt sends nothing", async () => {
		const abort = new AbortController();
		const f = fake({ inventory: [[CTL, C1]] });
		const envelope = await runFake(f, {
			command: "/ip/address/add address=192.0.2.9/32 interface=ether1",
			stdinIsTty: true,
			signal: abort.signal,
			confirm: async () => {
				abort.abort();
				return true;
			},
		});
		expect(f.dispatch).toEqual([]);
		expect(
			envelope.data.targets.map((t) => (t.ok ? "ok" : t.error.code)),
		).toEqual(["cmr/cancelled", "cmr/cancelled"]);
	});

	test("Ctrl-C while the write prompt waits ends the prompt; nothing is sent", async () => {
		const abort = new AbortController();
		const f = fake({ inventory: [[CTL, C1]] });
		setTimeout(() => abort.abort(), 20);
		const envelope = await runFake(f, {
			command: "/ip/address/add address=192.0.2.9/32 interface=ether1",
			stdinIsTty: true,
			signal: abort.signal,
			// A prompt still waiting on stdin: it never answers.
			confirm: () => new Promise<boolean>(() => {}),
		});
		expect(f.dispatch).toEqual([]);
		expect(
			envelope.data.targets.map((t) => (t.ok ? "ok" : t.error.code)),
		).toEqual(["cmr/cancelled", "cmr/cancelled"]);
	}, 2_000);

	test("cancelling during preflight is an outer cmr/cancelled, not a selection fault", async () => {
		const abort = new AbortController();
		abort.abort();
		const f = fake({ inventory: [[CTL, C1]] });
		const error = await rejection(runFake(f, { signal: abort.signal }));
		expect(error.code).toBe("cmr/cancelled");
		expect(f.preflight).toEqual([]);
		expect(f.dispatch).toEqual([]);
	});

	test("cancelling during dispatch: no member is sent after the abort", async () => {
		const abort = new AbortController();
		const f = fake({
			inventory: [[CTL, C1, C3]],
			onDispatch: () => abort.abort(),
		});
		const envelope = await executeCmr(
			{ ...request(), signal: abort.signal, concurrency: 1 },
			{ CENTRS_SKIP_ENV_FILE: "1" },
			{ controller: () => f.controller, nonce: () => NONCE },
		);
		expect(f.dispatch.map((c) => c.numbers)).toEqual(["*1"]);
		expect(
			envelope.data.targets.slice(1).map((t) => (t.ok ? "ok" : t.error.code)),
		).toEqual(["cmr/cancelled", "cmr/cancelled"]);
	});
});

describe("execute --cmr: cancellation through the production adapters", () => {
	// The fake controller above resolves when cancelled; the real adapters
	// reject. Hold the controller's first answer on loopback, abort once the
	// request has arrived, and the outcome must still be cmr/cancelled.
	test("rest-api: aborting while /cmr/device is held is cmr/cancelled", async () => {
		const arrived = Promise.withResolvers<void>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				arrived.resolve();
				return new Promise<Response>((resolve) => {
					req.signal.addEventListener("abort", () =>
						resolve(new Response(null, { status: 499 })),
					);
				});
			},
		});
		try {
			const abort = new AbortController();
			const running = executeCmr(
				{
					targetInput: "127.0.0.1",
					port: server.port,
					username: "admin",
					password: "",
					via: "rest-api",
					labels: "all",
					command: ":put x",
					stdinIsTty: false,
					timeout: "5s",
					signal: abort.signal,
				},
				{ CENTRS_SKIP_ENV_FILE: "1" },
			);
			await arrived.promise;
			abort.abort();
			expect((await rejection(running)).code).toBe("cmr/cancelled");
		} finally {
			server.stop(true);
		}
	}, 5_000);

	test("native-api: aborting while the controller login is held is cmr/cancelled", async () => {
		const arrived = Promise.withResolvers<void>();
		const listener = Bun.listen<undefined>({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data: () => arrived.resolve() },
		});
		try {
			const abort = new AbortController();
			const running = executeCmr(
				{
					targetInput: "127.0.0.1",
					port: listener.port,
					username: "admin",
					password: "",
					via: "native-api",
					labels: "all",
					command: ":put x",
					stdinIsTty: false,
					timeout: "5s",
					signal: abort.signal,
				},
				{ CENTRS_SKIP_ENV_FILE: "1" },
			);
			await arrived.promise;
			abort.abort();
			expect((await rejection(running)).code).toBe("cmr/cancelled");
		} finally {
			listener.stop(true);
		}
	}, 5_000);
});

describe("execute --cmr: CLI usage", () => {
	let saved: Record<string, string> = {};
	beforeEach(() => {
		saved = {};
		for (const [key, value] of Object.entries(Bun.env)) {
			if (key.startsWith("CENTRS_") && value !== undefined) saved[key] = value;
		}
		for (const key of Object.keys(Bun.env))
			if (key.startsWith("CENTRS_")) delete Bun.env[key];
		Bun.env["CENTRS_SKIP_ENV_FILE"] = "1";
	});
	afterEach(() => {
		for (const key of Object.keys(Bun.env))
			if (key.startsWith("CENTRS_")) delete Bun.env[key];
		Object.assign(Bun.env, saved);
	});

	const usage: Array<[string, string[], string]> = [
		[
			"--labels without --cmr",
			["execute", "ctl", "--labels", "all", "--json", "--", ":put 1"],
			"usage/conflicting-flags",
		],
		[
			"--cmr with a CDB selector",
			[
				"execute",
				"--cmr",
				"--labels",
				"all",
				"--group",
				"g",
				"--json",
				":put 1",
			],
			"usage/conflicting-flags",
		],
		[
			"--cmr with two targets",
			[
				"execute",
				"a",
				"b",
				"--cmr",
				"--labels",
				"all",
				"--json",
				"--",
				":put 1",
			],
			"usage/conflicting-flags",
		],
		[
			"--cmr without --labels",
			["execute", "ctl", "--cmr", "--json", "--", ":put 1"],
			"usage/missing-labels",
		],
	];
	for (const [name, args, code] of usage) {
		test(`${name} → ${code}`, async () => {
			const result = await run(args);
			expect(result.code).toBe(1);
			expect(JSON.parse(result.err).error.code).toBe(code);
		});
	}
});

describe("console-only CMR views are refused before dialing", () => {
	const DASHBOARD = "/cmr/device/dashboard numbers=*2";
	const env = { CENTRS_SKIP_ENV_FILE: "1" };
	const target = { targetInput: "192.0.2.1", stdinIsTty: false };

	// Every spelling RouterOS runs: literal, abbreviated, console spacing, and
	// inside a multi-line script (CMR12 proves those run every line).
	for (const command of [
		DASHBOARD,
		"/cmr/dev/dash numbers=*2",
		"/cm/d/d",
		"/cmr device dashboard numbers=*2",
		':put "before"\n/cmr/device/dashboard numbers=*2',
		":do { /cmr/device/da } on-error={}",
	]) {
		test(`execute ${JSON.stringify(command)}`, async () => {
			const error = await rejection(
				resolveExecuteRequest({ ...target, command }, env),
			);
			expect(error.code).toBe("cmr/console-only");
		});
	}

	test("api POST /execute with the dashboard as its script", async () => {
		const error = await rejection(
			resolveApiRequest(
				{
					...target,
					method: "POST",
					endpoint: "execute",
					fields: { script: "/cmr/dev/dashboard" },
				},
				env,
			),
		);
		expect(error.code).toBe("cmr/console-only");
	});

	test("api with an abbreviated path", async () => {
		const error = await rejection(
			resolveApiRequest(
				{ ...target, method: "POST", endpoint: "cmr/dev/dash" },
				env,
			),
		);
		expect(error.code).toBe("cmr/console-only");
	});

	for (const method of ["POST", "GET"]) {
		test(`api ${method}`, async () => {
			const error = await rejection(
				resolveApiRequest(
					{ ...target, method, endpoint: "/cmr/device/dashboard/" },
					env,
				),
			);
			expect(error.code).toBe("cmr/console-only");
		});
	}

	test("execute --cmr refuses it before reading the inventory", async () => {
		const f = fake({ inventory: [[CTL, C1]] });
		const error = await rejection(runFake(f, { command: DASHBOARD }));
		expect(error.code).toBe("cmr/console-only");
		expect(f.preflight).toEqual([]);
	});

	for (const command of [
		"/cmr/device/print",
		"/cmr/device/print detail",
		"/cmr/device/disable *2",
		"/system/device-mode/print",
		":put cmr-device-dashboard",
		':put ("cmr" . "device" . "dashboard")',
		'/cmr/device/run-script labels=all script=":put x"',
	]) {
		test(`not refused: ${JSON.stringify(command)}`, async () => {
			const resolved = await resolveExecuteRequest({ ...target, command }, env);
			expect(resolved.command).toBe(command);
		});
	}
});

describe("raw run-script through api/execute: validation is scoped to the controller", () => {
	const env = { CENTRS_SKIP_ENV_FILE: "1" };
	const codes = (warnings: readonly { code: string }[]) =>
		warnings.map((w) => w.code);

	for (const endpoint of [
		"/cmr/device/run-script",
		"rest/cmr/device/run-script/",
	]) {
		test(`api POST ${endpoint} warns the client script was not validated`, async () => {
			const resolved = await resolveApiRequest(
				{
					targetInput: "127.0.0.1",
					endpoint,
					method: "POST",
					fields: { labels: "all", script: ":put 1" },
				},
				env,
			);
			expect(codes(resolved.warnings)).toEqual([
				"cmr/client-script-not-validated",
			]);
		});
	}

	test("api GET /cmr/device does not warn", async () => {
		const resolved = await resolveApiRequest(
			{ targetInput: "127.0.0.1", endpoint: "/cmr/device", method: "GET" },
			env,
		);
		expect(codes(resolved.warnings)).toEqual([]);
	});

	const commands: Array<[string, string[]]> = [
		[
			'/cmr/device/run-script labels=all script=":put 1"',
			["cmr/client-script-not-validated"],
		],
		[
			'/cmr/device run-script labels=all script=":put 1"',
			["cmr/client-script-not-validated"],
		],
		[
			':do { /cmr/device/run-script labels=all script=":put 1" }',
			["cmr/client-script-not-validated"],
		],
		["/cmr/device/print", []],
		[":put run-script", []],
	];
	for (const [command, expected] of commands) {
		test(`execute ${command}`, async () => {
			const resolved = await resolveExecuteRequest(
				{ targetInput: "127.0.0.1", command },
				env,
			);
			expect(codes(resolved.warnings)).toEqual(expected);
		});
	}
});
