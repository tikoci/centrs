import { describe, expect, test } from "bun:test";
import { renderApiEnvelope, renderApiStreamLine } from "../../src/api.ts";
import { renderApiFanoutEnvelope } from "../../src/api-fanout.ts";
import {
	renderBtestClientEnvelope,
	renderBtestServerEnvelope,
} from "../../src/btest.ts";
import type { EnvelopeTargetMeta } from "../../src/core/envelope.ts";
import { renderDevicesEnvelope } from "../../src/devices.ts";
import { renderDiscoverEnvelope } from "../../src/discover.ts";
import {
	CentrsError,
	formatCentrsErrorLine,
	formatCentrsErrorText,
	type SerializedCentrsError,
	serializeCentrsError,
} from "../../src/errors.ts";
import { renderExecuteEnvelope } from "../../src/execute.ts";
import { renderExecuteFanoutEnvelope } from "../../src/execute-fanout.ts";
import { renderExplainEnvelope } from "../../src/explain.ts";
import { renderRetrieveEnvelope } from "../../src/retrieve.ts";
import { renderRetrieveFanoutEnvelope } from "../../src/retrieve-fanout.ts";
import { renderSettingsEnvelope } from "../../src/settings.ts";
import { renderTransferEnvelope } from "../../src/transfer.ts";
import { renderTransferFanoutEnvelope } from "../../src/transfer-fanout.ts";

// GH#362: every command renders an error through `formatCentrsErrorText`. Before
// this, five commands each re-derived the header and dropped `Details:`, `At:`
// and the device's own words. The text path of each renderer reads only
// `error` (plus warnings/tips, empty here), so a minimal envelope is enough.
const error = serializeCentrsError(
	new CentrsError({
		code: "validation/syntax",
		summary: "RouterOS rejected the command syntax while parsing it.",
		remediation: "Fix the syntax.",
		position: { line: 1, column: 2 },
		context: { detail: "bad command name zerotier (line 1 column 2)" },
	}),
);
const envelope = {
	ok: false,
	error,
	warnings: [],
	tips: [],
	meta: { target: { input: "r1" }, via: null, settings: {} },
} as never;

const renderers: Record<string, () => string> = {
	execute: () => renderExecuteEnvelope(envelope, "text"),
	retrieve: () => renderRetrieveEnvelope(envelope, "text"),
	api: () => renderApiEnvelope(envelope, "text"),
	transfer: () => renderTransferEnvelope(envelope, "text"),
	settings: () => renderSettingsEnvelope(envelope, "text"),
	devices: () => renderDevicesEnvelope(envelope, "text"),
	discover: () => renderDiscoverEnvelope(envelope, "text"),
	explain: () => renderExplainEnvelope(envelope, "text"),
	"btest client": () => renderBtestClientEnvelope(envelope, "text"),
	"btest server": () => renderBtestServerEnvelope(envelope, "text"),
	"execute fan-out": () => renderExecuteFanoutEnvelope(envelope, "text"),
	"retrieve fan-out": () => renderRetrieveFanoutEnvelope(envelope, "text"),
	"api fan-out": () => renderApiFanoutEnvelope(envelope, "text"),
	"transfer fan-out": () => renderTransferFanoutEnvelope(envelope, "text"),
};

describe("error text parity (GH#362)", () => {
	const expected = formatCentrsErrorText(error);

	test("the shared renderer carries position, device words and details", () => {
		expect(expected).toContain("At: line 1, column 2");
		expect(expected).toContain("Device said: bad command name zerotier");
		expect(expected).toContain("Details: https://tikoci.github.io/centrs/");
	});

	for (const [command, render] of Object.entries(renderers)) {
		test(`${command} starts with the shared error text`, () => {
			expect(render().startsWith(expected)).toBe(true);
		});
	}

	test("api --stream renders the same fields on one line", () => {
		const line = renderApiStreamLine(envelope, "text");
		expect(line).toBe(formatCentrsErrorLine(error));
		expect(line).not.toContain("\n");
		for (const field of [
			"At: line 1, column 2",
			"Device said:",
			"Fix:",
			"Details:",
		])
			expect(line).toContain(field);
	});
});

function compactFanoutEnvelope(
	error: SerializedCentrsError,
	target: EnvelopeTargetMeta,
) {
	return {
		ok: true as const,
		data: {
			summary: { total: 1, ok: 0, failed: 1 },
			targets: [
				{
					ok: false as const,
					error,
					warnings: [],
					tips: [],
					meta: {
						target: { recordIndex: 3, ...target },
						via: null,
						settings: {},
					},
				},
			],
		},
		warnings: [],
		tips: [],
		meta: { target: {}, via: null, settings: {} },
	};
}

const compactFanoutRenderers = {
	execute: renderExecuteFanoutEnvelope,
	retrieve: renderRetrieveFanoutEnvelope,
	api: renderApiFanoutEnvelope,
	transfer: renderTransferFanoutEnvelope,
};

// Include every C0/C1 control, including LF/tab that full error text permits.
const controls = [
	...Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)),
	...Array.from({ length: 33 }, (_, index) => String.fromCharCode(127 + index)),
].join("");

describe("compact error lines (GH#395, GH#415)", () => {
	const plainError = serializeCentrsError(
		new CentrsError({
			code: "routeros/api-trap",
			summary: "Device refused the request.",
			remediation: "Try again.",
		}),
	);
	const hostileError = serializeCentrsError(
		new CentrsError({
			code: "routeros/api-trap",
			summary: `Device said:${controls}forged FAIL row`,
			remediation: `Try:${controls}forged Fix row`,
		}),
	);

	for (const [command, render] of Object.entries(compactFanoutRenderers)) {
		test(`${command} keeps the compact FAIL and verbose Fix layout`, () => {
			const envelope = compactFanoutEnvelope(plainError, { identity: "r1" });
			const normal = render(envelope, "text").split("\n");
			expect(normal).toHaveLength(2);
			expect(normal[1]).toBe(
				"  [3] FAIL  r1 [routeros/api-trap] Device refused the request.",
			);
			expect(render(envelope, "text", { verbose: true }).split("\n")).toEqual([
				...normal,
				"        Fix: Try again.",
			]);
		});

		for (const label of ["identity", "host", "input"] as const) {
			test(`${command} filters controls in ${label}, summary and verbose remediation`, () => {
				const envelope = compactFanoutEnvelope(hostileError, {
					[label]: `r1${controls}forged label`,
				});
				for (const verbose of [false, true]) {
					const lines = render(envelope, "text", { verbose }).split("\n");
					expect(lines).toHaveLength(verbose ? 3 : 2);
					for (const line of lines) {
						for (const control of controls) expect(line).not.toContain(control);
					}
					expect(lines[1]).toContain(
						"forged label [routeros/api-trap] Device said:",
					);
					expect(lines[1]).toEndWith("forged FAIL row");
					if (verbose) expect(lines[2]).toEndWith("forged Fix row");
				}
				const json = JSON.parse(render(envelope, "json"));
				expect(json.data.targets[0].error).toEqual(hostileError);
				expect(json.data.targets[0].meta.target[label]).toBe(
					envelope.data.targets[0]?.meta.target[label],
				);
			});
		}
	}

	for (const [role, render] of Object.entries({
		client: renderBtestClientEnvelope,
		server: renderBtestServerEnvelope,
	})) {
		test(`btest ${role} keeps one filtered CSV error comment after its header`, () => {
			const envelope = {
				ok: false as const,
				error: hostileError,
				warnings: [],
				tips: [],
				meta: { target: {}, via: null, settings: {} },
			};
			const lines = render(envelope, "csv").split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe(
				role === "client"
					? "seq,direction,protocol,tx_bps,rx_bps,lost_packets,tx_bytes,rx_bytes"
					: "duration_ms,event,client,protocol,direction,user,tx_bps,rx_bps,lost_packets",
			);
			expect(lines[1]).toStartWith("# error: [routeros/api-trap] Device said:");
			expect(lines[1]).toEndWith("forged FAIL row");
			for (const control of controls) expect(lines[1]).not.toContain(control);
			expect(JSON.parse(render(envelope, "json")).error).toEqual(hostileError);
		});
	}
});
