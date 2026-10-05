import { describe, expect, test } from "bun:test";
import { renderApiEnvelope, renderApiStreamLine } from "../../src/api.ts";
import { renderApiFanoutEnvelope } from "../../src/api-fanout.ts";
import {
	renderBtestClientEnvelope,
	renderBtestServerEnvelope,
} from "../../src/btest.ts";
import { renderDevicesEnvelope } from "../../src/devices.ts";
import { renderDiscoverEnvelope } from "../../src/discover.ts";
import {
	CentrsError,
	formatCentrsErrorLine,
	formatCentrsErrorText,
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
