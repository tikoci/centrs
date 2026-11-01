// cspell:ignore héllo hllo
import { describe, expect, test } from "bun:test";
import slice from "../fixtures/explain/context-matrix.slice.json" with {
	type: "json",
};

/**
 * #574 submission-matrix evidence slice: scope, menu, and encoding probes
 * across centrs' delivery routes on CHR 7.24.5.
 *
 * Recorded by `bun run explain:probe:context-matrix` (two disposable CHRs,
 * every product cell through `executeEnvelope` with pinned `--via`),
 * replicated on a second full-matrix pass with identical outcomes. This test
 * replays the RECORDED conclusions without a router — it pins the slice
 * contract, not the device. Re-derive live with that command; a device that
 * disagrees with the slice means the slice (and these assertions) needs
 * re-recording, not a silent update.
 *
 * Two cells are KNOWN centrs bugs, not device answers: the mac-telnet reader
 * drops :put output for trailing-newline single-line sends (the committed
 * raw screens prove the device printed), and ssh multiline menu navigation
 * exits 1 while validation passed. Both have follow-up issues; the slice
 * pins the broken behavior until a re-recorded matrix shows the fix.
 */

interface Submission {
	bytes: string;
	sha256: string;
	ok: boolean;
	out?: string;
	error?: { code: string; summary: string; cause?: string };
	stages?: [string, string][];
	infraSuspect?: boolean;
	note?: string;
	raw?: string;
}

interface Cell {
	cell: string;
	input: string;
	route: string;
	submissions: Submission[];
	fallbacks?: { bytes: string; ok: boolean; out: string; reason: string }[];
}

const cells = slice.cells as Cell[];
const cell = (id: string): Cell => {
	const found = cells.find((c) => c.cell === id);
	if (!found) throw new Error(`no recorded cell ${id}`);
	return found;
};
const out = (c: Cell, i: number): string => c.submissions[i]?.out ?? "";
const code = (c: Cell, i: number): string =>
	c.submissions[i]?.error?.code ?? "";

describe("context-matrix evidence slice (#574)", () => {
	test("the slice covers the full matrix", () => {
		expect(slice.routerosVersion).toBe("7.24.5 (stable)");
		expect(cells).toHaveLength(59);
		expect(slice.gateTable).toHaveLength(11);
		for (const route of [
			"rest",
			"native",
			"ssh",
			"mactelnet",
			"session",
			"stored",
		])
			expect(cells.some((c) => c.route === route)).toBe(true);
		for (const input of [
			"I1-nl-scope",
			"I2-semi-scope",
			"I3-braces-1line",
			"I4-braces-multi",
			"I5-global",
			"I6-menu",
			"I7-unicode",
			"I8-bom",
		])
			expect(cells.some((c) => c.input === input)).toBe(true);
	});

	test("/execute and stored scripts run multiline input as one scope", () => {
		for (const id of [
			"I1-nl-scope-rest",
			"I2-semi-scope-rest",
			"I3-braces-1line-rest",
			"I4-braces-multi-rest",
			"I1-nl-scope-native",
			"I4-braces-multi-native",
			"I1-nl-scope-stored",
			"I4-braces-multi-stored",
		])
			expect(out(cell(id), 0)).toContain("a=2");
		// Braced multiline is one submission on the console too.
		expect(out(cell("I4-braces-multi-mactelnet"), 0)).toContain("a=2");
		expect(out(cell("I4-braces-multi-session"), 0)).toContain("a=2");
	});

	test("ssh and mac-telnet run multiline sends per line", () => {
		const ssh = out(cell("I1-nl-scope-ssh"), 0);
		expect(ssh).toContain("syntax error (line 1 column 6)");
		expect(ssh).toContain("a=");
		expect(ssh).not.toContain("a=2");
		const sshBraces = out(cell("I4-braces-multi-ssh"), 0);
		expect(sshBraces).toContain("missing closing brace (line 1 column 2)");
		const mac = out(cell("I1-nl-scope-mactelnet"), 0);
		expect(mac).toContain("a=");
		expect(mac).not.toContain("a=2");
	});

	test("semicolons are one scope on every route", () => {
		for (const id of [
			"I2-semi-scope-rest",
			"I2-semi-scope-native",
			"I2-semi-scope-ssh",
			"I2-semi-scope-stored",
		])
			expect(out(cell(id), 0)).toContain("a=2");
		// The console ran it too — the raw screen shows a=2 — but the
		// mac-telnet reader lost the output (follow-up issue).
		const session = cell("I2-semi-scope-session").submissions[0];
		expect(session?.raw ?? "").toContain("a=2");
		expect(session?.out ?? "").not.toContain("a=2");
	});

	test("split submissions never share locals", () => {
		for (const route of ["rest", "native", "ssh", "mactelnet"]) {
			const c = cell(`I1-nl-scope-${route}-split`);
			// The middle :set is validation-rejected on the device stage, and
			// the device agrees (direct fallback).
			expect(code(c, 1)).toBe("validation/syntax");
			expect(c.submissions[1]?.stages).toContainEqual(["device", "failed"]);
			expect(c.fallbacks?.[0]?.out ?? "").toContain(
				"syntax error (line 1 column 6)",
			);
			// The trailing :put runs and sees nothing.
			expect(out(c, 2)).toContain("a=");
			expect(out(c, 2)).not.toContain("a=2");
		}
		// The held console answers the same lines without validation.
		const session = cell("I1-nl-scope-session-split");
		expect(out(session, 1)).toContain("syntax error (line 1 column 6)");
		expect(out(session, 2)).toContain("a=");
	});

	test("globals cross every submission boundary", () => {
		for (const id of [
			"I5-global-rest-split",
			"I5-global-native-split",
			"I5-global-ssh-split",
			"I5-global-stored-split",
		])
			expect(out(cell(id), 1)).toContain("g=11");
		// The held console printed g=11 too (raw screen); the reader lost it.
		const session = cell("I5-global-session-split").submissions[1];
		expect(session?.raw ?? "").toContain("g=11");
		expect(session?.out ?? "").not.toContain("g=11");
	});

	test("menu context holds within one submission on every running route", () => {
		for (const id of [
			"I6-menu-rest",
			"I6-menu-native",
			"I6-menu-stored",
			"I6-menu-mactelnet",
			"I6-menu-session",
		])
			expect(out(cell(id), 0)).toContain("192.0.2.44");
		// ...except ssh, where the device channel exits 1 with no output
		// after validation passed (reproduced 3/3; follow-up filed).
		const ssh = cell("I6-menu-ssh").submissions[0];
		expect(code(cell("I6-menu-ssh"), 0)).toBe("transport/network");
		expect(ssh?.infraSuspect).toBe(true);
		expect(ssh?.stages).toContainEqual(["device", "passed"]);
	});

	test("menu context across submissions holds only on a held console", () => {
		// Bare navigation fails over /execute but runs on console routes.
		expect(code(cell("I6-menu-rest-split"), 0)).toBe("routeros/request-failed");
		expect(code(cell("I6-menu-native-split"), 0)).toBe("routeros/api-trap");
		expect(cell("I6-menu-ssh-split").submissions[0]?.ok).toBe(true);
		expect(cell("I6-menu-mactelnet-split").submissions[0]?.ok).toBe(true);
		// A bare print is validation-rejected on every product route...
		for (const route of ["rest", "native", "ssh", "mactelnet"])
			expect(code(cell(`I6-menu-${route}-split`), 1)).toBe(
				"validation/unknown-path",
			);
		// ...runs nowhere outside its menu (stored) ...
		expect(code(cell("I6-menu-stored-split"), 1)).toBe("routeros/unknown-path");
		// ...and sees the held menu on one console.
		expect(out(cell("I6-menu-session-split"), 1)).toContain("192.0.2.44");
	});

	test("console input strips non-ascii bytes; /execute preserves them", () => {
		for (const id of [
			"I7-unicode-rest",
			"I7-unicode-native",
			"I7-unicode-stored",
		])
			expect(out(cell(id), 0)).toContain("héllo→574");
		expect(out(cell("I7-unicode-ssh"), 0)).toContain("hllo574");
		const session = cell("I7-unicode-session").submissions[0];
		expect(session?.raw ?? "").toContain("hllo574");
		expect(session?.out ?? "").not.toContain("hllo574");
	});

	test("a leading BOM splits by device path", () => {
		// REST/native device :parse rejects; the device agrees when asked raw.
		for (const route of ["rest", "native"]) {
			const c = cell(`I8-bom-${route}`);
			expect(code(c, 0)).toBe("validation/syntax");
			expect(c.submissions[0]?.stages).toContainEqual(["device", "failed"]);
			expect(c.fallbacks?.[0]?.out ?? "").toContain(
				"expected command name (line 1 column 1)",
			);
		}
		// The console accepts and ignores the BOM.
		for (const id of ["I8-bom-ssh", "I8-bom-mactelnet", "I8-bom-session"])
			expect(out(cell(id), 0)).toContain("bom574");
		// A stored script carrying a BOM fails at run.
		expect(code(cell("I8-bom-stored"), 0)).toBe("routeros/request-failed");
	});

	test("the write gate sees every scope-bearing shape", () => {
		const gate = Object.fromEntries(
			(slice.gateTable as { shape: string; code: string }[]).map((g) => [
				g.shape,
				g.code,
			]),
		);
		for (const shape of ["I1", "I2", "I3", "I4", "I5-set", "script-run"])
			expect(gate[shape]).toBe("usage/confirmation-required");
		for (const shape of ["I5-read", "I7"]) expect(gate[shape]).toBe("ran");
		expect(gate["I6-nav"]).toBe("routeros/request-failed");
		expect(gate["I6-print"]).toBe("validation/unknown-path");
		expect(gate["I8"]).toBe("validation/syntax");
	});

	test("recorded inputs hash to the committed bytes", async () => {
		const { createHash } = await import("node:crypto");
		for (const c of cells)
			for (const s of c.submissions) {
				expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
				expect(createHash("sha256").update(s.bytes, "utf8").digest("hex")).toBe(
					s.sha256,
				);
			}
	});
});
