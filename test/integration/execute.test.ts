import { describe, expect, test } from "bun:test";
import { executeEnvelope } from "../../src/execute.ts";
import { retrieve } from "../../src/retrieve.ts";
import {
	exampleIds,
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
	VALIDATION_REJECT_CODES,
} from "./chr.ts";

const runFastIntegration = isChrIntegrationEnabled();
const describeFast = runFastIntegration ? describe : describe.skip;

interface ExecuteSuccessEnvelope {
	ok: true;
	data: Record<string, unknown> | string;
	meta: {
		via: string;
		validation?: {
			source?: string;
			syntax?: boolean;
			semantic?: boolean | string;
			enabled?: boolean;
		};
	};
}

interface ExecuteFailureEnvelope {
	ok: false;
	error: { code?: string; cause?: unknown; context?: Record<string, unknown> };
	meta: {
		via: string | null;
		validation?: { enabled?: boolean; source?: string };
	};
}

function expectExecuteSuccess(
	envelope: Awaited<ReturnType<typeof executeEnvelope>>,
	via: "rest-api" | "native-api",
): ExecuteSuccessEnvelope {
	expect(envelope.ok).toBe(true);
	expect(envelope.meta.via).toBe(via);
	return envelope as ExecuteSuccessEnvelope;
}

function expectExecuteFailure(
	envelope: Awaited<ReturnType<typeof executeEnvelope>>,
	via: "rest-api" | "native-api",
	code: string | readonly string[],
): ExecuteFailureEnvelope {
	expect(envelope.ok).toBe(false);
	expect(envelope.meta.via).toBe(via);
	const failure = envelope as ExecuteFailureEnvelope;
	const acceptable: readonly string[] =
		typeof code === "string" ? [code] : code;
	expect(acceptable).toContain(failure.error.code ?? "");
	return failure;
}

async function readAddressById(args: {
	targetInput: string;
	via: "rest-api" | "native-api";
	port?: number;
	username: string;
	password: string;
	id: string;
}): Promise<Record<string, unknown> | undefined> {
	const envelope = await retrieve({
		targetInput: args.targetInput,
		path: "/ip/address",
		via: args.via,
		port: args.port,
		username: args.username,
		password: args.password,
	});
	expect(envelope.ok).toBe(true);
	const rows = Array.isArray(envelope.data) ? envelope.data : [];
	return rows.find(
		(row): row is Record<string, unknown> =>
			typeof row === "object" &&
			row !== null &&
			(row as Record<string, unknown>)[".id"] === args.id,
	);
}

async function ensureNoAddressWithComment(args: {
	targetInput: string;
	via: "rest-api" | "native-api";
	port?: number;
	username: string;
	password: string;
	comment: string;
}): Promise<void> {
	const envelope = await retrieve({
		targetInput: args.targetInput,
		path: "/ip/address",
		via: args.via,
		port: args.port,
		username: args.username,
		password: args.password,
	});
	expect(envelope.ok).toBe(true);
	const rows = Array.isArray(envelope.data) ? envelope.data : [];
	expect(
		rows.some(
			(row) =>
				typeof row === "object" &&
				row !== null &&
				(row as Record<string, unknown>)["comment"] === args.comment,
		),
	).toBe(false);
}

function idFromData(data: Record<string, unknown> | string): string {
	expect(typeof data).toBe("object");
	const record = data as Record<string, unknown>;
	const id = record[".id"] ?? record["ret"];
	expect(id).toMatch(/^\*[0-9A-F]+$/i);
	return String(id);
}

describeFast("execute against CHR", () => {
	test("runs rest-api execute examples 1-11", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const base = {
				targetInput: chr.restUrl,
				via: "rest-api" as const,
				username: auth.username,
				password: auth.password,
			};

			const add = expectExecuteSuccess(
				await executeEnvelope({
					...base,
					command:
						'/ip/address/add address=198.51.100.10/32 interface=ether1 comment="centrs-execute-rest"',
					yes: true,
				}),
				"rest-api",
			);
			expect(add.meta.validation?.source).toContain(":put [:parse");
			expect(add.meta.validation?.source).toContain("/console/inspect");
			const id = idFromData(add.data);

			const set = expectExecuteSuccess(
				await executeEnvelope({
					...base,
					command: `/ip/address/set numbers=${id} comment=centrs-execute-rest-set`,
					yes: true,
				}),
				"rest-api",
			);
			expect(set.data).toBeDefined();
			expect(await readAddressById({ ...base, id })).toMatchObject({
				comment: "centrs-execute-rest-set",
			});

			expectExecuteSuccess(
				await executeEnvelope({
					...base,
					command: `/ip/address/remove numbers=${id}`,
					yes: true,
				}),
				"rest-api",
			);
			expect(await readAddressById({ ...base, id })).toBeUndefined();

			const script = expectExecuteSuccess(
				await executeEnvelope({
					...base,
					command: ":put [/system/identity/get name]",
				}),
				"rest-api",
			);
			// Assert the `:put [...]` script returned the *live* identity rather than a
			// hard-coded "CHR": the default identity is version/image-dependent
			// (e.g. "MikroTik" on 7.21.4 long-term, not "CHR"). (JG-14.)
			const liveIdentity =
				((await chr.rest("/system/identity")) as Record<string, string>)[
					"name"
				] ?? "";
			expect(liveIdentity.length).toBeGreaterThan(0);
			expect(JSON.stringify(script.data)).toContain(liveIdentity);
			expect(script.meta.validation?.syntax).toBe(true);
			expect(script.meta.validation?.semantic).toBe("not-applicable");

			expectExecuteFailure(
				await executeEnvelope({
					...base,
					command: '/ip/address/add address="unterminated interface=ether1',
					yes: true,
				}),
				"rest-api",
				"validation/syntax",
			);

			const semantic = expectExecuteFailure(
				await executeEnvelope({
					...base,
					command:
						"/ip/address/add address=198.51.100.11/32 interface=ether1 no-such-arg=x",
					yes: true,
				}),
				"rest-api",
				VALIDATION_REJECT_CODES,
			);
			// The offending attribute name is only surfaced when RouterOS reports it as
			// a `bad parameter` (≥ 7.23, via /console/inspect). On ≤ 7.21.x the `:parse`
			// syntax gate rejects it generically first, so there is no attribute. (JG-14.)
			if (semantic.error.code === "validation/unknown-attribute") {
				expect(semantic.error.context?.["attribute"]).toBe("no-such-arg");
			}
			await ensureNoAddressWithComment({ ...base, comment: "missing-confirm" });

			expectExecuteFailure(
				await executeEnvelope({
					...base,
					command: ':error "centrs execute fixture trap"',
				}),
				"rest-api",
				"routeros/command-failed",
			);

			expectExecuteSuccess(
				await executeEnvelope({
					...base,
					command: ':put "requires rest execute"',
				}),
				"rest-api",
			);

			expectExecuteFailure(
				await executeEnvelope({
					...base,
					command:
						'/ip/address/add address=198.51.100.12/32 interface=ether1 comment="missing-confirm"',
					stdinIsTty: false,
				}),
				"rest-api",
				"usage/confirmation-required",
			);
			await ensureNoAddressWithComment({ ...base, comment: "missing-confirm" });

			expectExecuteFailure(
				await executeEnvelope({
					...base,
					command:
						'/ip/address/add address=198.51.100.13/32 interface=ether1 comment="tty-confirm-no"',
					stdinIsTty: true,
					confirm: async () => false,
				}),
				"rest-api",
				"usage/confirmation-required",
			);
			const ttyAdd = expectExecuteSuccess(
				await executeEnvelope({
					...base,
					command:
						'/ip/address/add address=198.51.100.13/32 interface=ether1 comment="tty-confirm"',
					stdinIsTty: true,
					confirm: async () => true,
				}),
				"rest-api",
			);
			await executeEnvelope({
				...base,
				command: `/ip/address/remove numbers=${idFromData(ttyAdd.data)}`,
				yes: true,
			});

			const validateFalse = expectExecuteFailure(
				await executeEnvelope({
					...base,
					command:
						"/ip/address/add address=198.51.100.14/32 interface=ether1 no-such-arg=x",
					yes: true,
					validate: false,
				}),
				"rest-api",
				"routeros/unknown-attribute",
			);
			expect(validateFalse.meta.validation?.enabled).toBe(false);

			await recordIntegrationEvidence({
				suite: "execute against CHR",
				command: "execute",
				protocol: "rest-api",
				routerosVersion: chr.state.version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(11),
			});
		} finally {
			await chr.destroy();
		}
	}, 120_000);

	test("runs native-api execute examples 12-18", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const base = {
				targetInput: "127.0.0.1",
				via: "native-api" as const,
				port: chr.ports.api,
				username: auth.username,
				password: auth.password,
			};

			const add = expectExecuteSuccess(
				await executeEnvelope({
					...base,
					command:
						'/ip/address/add address=198.51.100.20/32 interface=ether1 comment="centrs-execute-api"',
					yes: true,
				}),
				"native-api",
			);
			expect(add.meta.validation?.source).toContain(":put [:parse");
			expect(add.meta.validation?.source).toContain("/console/inspect");
			const id = idFromData(add.data);

			expectExecuteSuccess(
				await executeEnvelope({
					...base,
					command: `/ip/address/set numbers=${id} comment=centrs-execute-api-set`,
					yes: true,
				}),
				"native-api",
			);
			expect(await readAddressById({ ...base, id })).toMatchObject({
				comment: "centrs-execute-api-set",
			});

			expectExecuteSuccess(
				await executeEnvelope({
					...base,
					command: `/ip/address/remove numbers=${id}`,
					yes: true,
				}),
				"native-api",
			);
			expect(await readAddressById({ ...base, id })).toBeUndefined();

			expectExecuteFailure(
				await executeEnvelope({
					...base,
					command: '/ip/address/add address="unterminated interface=ether1',
					yes: true,
				}),
				"native-api",
				"validation/syntax",
			);

			expectExecuteFailure(
				await executeEnvelope({
					...base,
					command:
						"/ip/address/add address=198.51.100.21/32 interface=ether1 no-such-arg=x",
					yes: true,
				}),
				"native-api",
				"validation/unknown-attribute",
			);

			const trap = expectExecuteFailure(
				await executeEnvelope({
					...base,
					command:
						"/ip/address/add address=198.51.100.22/32 interface=ether1 no-such-arg=x",
					yes: true,
					validate: false,
				}),
				"native-api",
				"routeros/unknown-attribute",
			);
			expect(trap.meta.validation?.enabled).toBe(false);

			expectExecuteFailure(
				await executeEnvelope({
					...base,
					command:
						'/ip/address/add address=198.51.100.23/32 interface=ether1 comment="api-missing-confirm"',
					stdinIsTty: false,
				}),
				"native-api",
				"usage/confirmation-required",
			);

			await recordIntegrationEvidence({
				suite: "execute against CHR",
				command: "execute",
				protocol: "native-api",
				routerosVersion: chr.state.version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(18).slice(11),
			});
		} finally {
			await chr.destroy();
		}
	}, 120_000);
});
