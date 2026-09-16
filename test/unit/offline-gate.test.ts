import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	assertOfflineSyntax,
	isOfflineGateRejection,
	OFFLINE_GATE_SOURCE,
} from "../../src/offline-gate.ts";

const surface = { surface: "execute", via: "rest-api" };

function reject(command: string): CentrsError {
	try {
		assertOfflineSyntax(command, surface);
	} catch (error) {
		if (error instanceof CentrsError) return error;
		throw error;
	}
	throw new Error(`expected ${JSON.stringify(command)} to be rejected`);
}

describe("offline gate — what it lets through", () => {
	// Every command string `commands/execute/examples.md` runs against CHR, minus
	// the one example that is MEANT to fail. Stage 1 sits in front of every
	// `execute` call, so a false reject here is a command centrs would refuse to
	// send at all — this list is the regression floor for that.
	test.each([
		'/ip/address/add address=198.51.100.10/32 interface=ether1 comment="centrs-execute-rest"',
		"/ip/address/set numbers=*1 comment=centrs-execute-rest-set",
		"/ip/address/remove numbers=*1",
		":local a true; :if ($a = true) do={:put [/system/identity/get name]}",
		"/ip/address/add address=198.51.100.11/32 interface=ether1 no-such-arg=x",
		':error "centrs execute fixture trap"',
		":put [/system/identity/get name]",
		"/system/identity/print",
		"/system/resource/print",
		"/system/identity/set name=chr-via-mac",
		":put 1",
	])("passes %j", (command) => {
		expect(assertOfflineSyntax(command, surface).verdict).toBe("pass");
	});

	test("an unknown attribute is stage 2's job, not stage 1's", () => {
		// The analyzer has no per-menu schema (decision 3 — no offline schema
		// snapshot), so it cannot know `no-such-arg` is not an argument of
		// `/ip/address/add`. Rejecting it here would be a guess; `/console/inspect`
		// answers it for real. This is why a clean stage 1 is never sufficient.
		expect(
			assertOfflineSyntax("/ip/address/add no-such-arg=x", surface).verdict,
		).toBe("pass");
	});

	test("an abstention is not a rejection", () => {
		// `warn` means the analyzer declined to judge part of the input. Turning
		// that into a refusal would make every unrecognized menu unreachable
		// through centrs.
		const result = assertOfflineSyntax("/ip/address/prnt", surface);
		expect(result.verdict).toBe("warn");
	});
});

describe("offline gate — what it stops", () => {
	test("an unterminated string is rejected with its byte span", () => {
		const error = reject(
			'/ip/address/add address="unterminated interface=ether1',
		);
		expect(error.code).toBe("validation/syntax");
		expect(error.context?.["validationStage"]).toBe("offline");
		expect(error.context?.["validationSource"]).toBe(OFFLINE_GATE_SOURCE);
		expect(error.context?.["surface"]).toBe("execute");
		expect(error.context?.["span"]).toEqual({ start: 24, end: 54 });
		expect(error.causeData).toBe("explain/canonicalizer/unterminated-string");
	});

	test("an unclosed bracket is rejected — the local quote preflight never saw it", () => {
		// `hasUnbalancedQuotes` in `execute.ts` counts quotes only, so `:put [`
		// used to cost a full round trip to be told no.
		const error = reject(":put [");
		expect(error.code).toBe("validation/syntax");
		expect(error.causeData).toBe("explain/canonicalizer/unclosed");
		expect(error.context?.["span"]).toEqual({ start: 5, end: 6 });
	});

	test("the rejection names the analyzer's own diagnostics", () => {
		const error = reject(':put "unterminated');
		const diagnostics = error.context?.["diagnostics"] as ReadonlyArray<{
			code: string;
			message: string;
			start: number;
			end: number;
		}>;
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(diagnostics[0]?.code).toBe(
			"explain/canonicalizer/unterminated-string",
		);
		expect(diagnostics[0]?.message.length).toBeGreaterThan(0);
	});

	test("the byte offset never masquerades as a RouterOS position", () => {
		// `RouterOsErrorPosition` is RouterOS's own authoritative byte column,
		// "carried verbatim; never re-derived" (`src/errors.ts`). An offline span
		// that filled it in would be indistinguishable from a device-reported one.
		expect(reject(":put [").position).toBeUndefined();
	});

	test("the remediation points at the analyzer and at the escape hatch", () => {
		const remediation = reject(":put [").remediation ?? "";
		expect(remediation).toContain("centrs explain");
		expect(remediation).toContain("--validate=false");
	});
});

describe("isOfflineGateRejection", () => {
	test("is true for a stage-1 rejection", () => {
		expect(isOfflineGateRejection(reject(":put ["))).toBe(true);
	});

	test("is false for a device-side syntax rejection", () => {
		// Same code, different stage. The distinction is what keeps
		// `meta.validation` from claiming a `:parse` that never ran.
		const deviceError = new CentrsError({
			code: "validation/syntax",
			summary:
				"RouterOS rejected the command syntax during `:parse` preflight.",
			context: { validationSource: ":put [:parse ...]" },
		});
		expect(isOfflineGateRejection(deviceError)).toBe(false);
	});

	test("is false for anything else", () => {
		expect(isOfflineGateRejection(new Error("boom"))).toBe(false);
		expect(isOfflineGateRejection(undefined)).toBe(false);
	});
});

describe("the quote-balance supplement", () => {
	// `'` is not a RouterOS string delimiter — it is not a legal token at all, and
	// the analyzer passes every form of it (#355). This check is what keeps stage 1
	// from being blind to the character class. It used to live in `execute.ts` as a
	// private `hasUnbalancedQuotes` guard *inside the device gate*, which made an
	// error envelope report a `:parse` that never ran.
	test("an unbalanced apostrophe is an OFFLINE rejection, not a device one", () => {
		const error = reject("/system/identity/set name=don't");
		expect(error.code).toBe("validation/syntax");
		expect(error.context?.["validationStage"]).toBe("offline");
		expect(error.context?.["validationSource"]).toContain("quote balance");
		expect(error.causeData).toBe("unterminated string literal");
		expect(isOfflineGateRejection(error)).toBe(true);
	});

	test("an apostrophe inside a real string is left alone", () => {
		// CHR accepts `comment="it's here"`; only the bare apostrophe is rejected.
		expect(
			assertOfflineSyntax(
				'/ip/address/add address=1.1.1.1/32 comment="it\'s here"',
				surface,
			).verdict,
		).toBe("pass");
	});

	test("the analyzer speaks first, so a precise span beats the coarse message", () => {
		// This input is BOTH an unterminated `"` and unbalanced by quote count. The
		// analyzer's diagnostic carries a byte span, so it must be the one reported.
		const error = reject(
			'/ip/address/add address="unterminated interface=ether1',
		);
		expect(error.causeData).toBe("explain/canonicalizer/unterminated-string");
		expect(error.context?.["span"]).toEqual({ start: 24, end: 54 });
	});
});
