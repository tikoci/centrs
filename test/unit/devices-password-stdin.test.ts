import { describe, expect, test } from "bun:test";
import { readPasswordStdin } from "../../src/cli/devices.ts";
import { CentrsError } from "../../src/errors.ts";
import { runCliCaptured } from "./cli-capture.ts";

// `devices add`/`set --password-stdin` (#582). The real fd-0 read is exercised
// by the subprocess tier (`test/integration/devices.test.ts`, examples 63-67);
// this file covers the newline/empty/TTY rules through the read seam and the
// argv refusals, which fire before stdin is touched.

const SECRET = "hidden-argv-value";

async function readError(
	source: Parameters<typeof readPasswordStdin>[0],
): Promise<CentrsError> {
	try {
		await readPasswordStdin(source);
	} catch (error) {
		expect(error).toBeInstanceOf(CentrsError);
		return error as CentrsError;
	}
	throw new Error("expected readPasswordStdin to throw");
}

describe("readPasswordStdin", () => {
	const pipedBytes = (bytes: Uint8Array) => ({
		isTty: false,
		read: async () => bytes,
	});
	const piped = (text: string) => pipedBytes(new TextEncoder().encode(text));

	test("strips exactly one trailing \\n", async () => {
		expect(await readPasswordStdin(piped("pw\n"))).toBe("pw");
		expect(await readPasswordStdin(piped("pw\n\n"))).toBe("pw\n");
	});

	test("strips exactly one trailing \\r\\n", async () => {
		expect(await readPasswordStdin(piped("pw\r\n"))).toBe("pw");
		expect(await readPasswordStdin(piped("pw\r\n\r\n"))).toBe("pw\r\n");
	});

	test("keeps a value with no trailing newline and inner/edge whitespace", async () => {
		expect(await readPasswordStdin(piped("pw"))).toBe("pw");
		expect(await readPasswordStdin(piped(" p w \n"))).toBe(" p w ");
		expect(await readPasswordStdin(piped("pw\r"))).toBe("pw\r");
	});

	test("empty stdin is input/empty-stdin", async () => {
		for (const text of ["", "\n", "\r\n"]) {
			const error = await readError(piped(text));
			expect(error.code).toBe("input/empty-stdin");
			expect(error.remediation).toContain('--password ""');
		}
	});

	test("keeps multi-byte UTF-8 intact", async () => {
		expect(await readPasswordStdin(piped("pw-\u00fc\u20ac\n"))).toBe(
			"pw-\u00fc\u20ac",
		);
	});

	test("malformed UTF-8 is input/invalid-stdin, never replaced or echoed", async () => {
		// 0xff is never valid UTF-8; 0xc3 alone is a truncated 2-byte sequence.
		for (const bytes of [
			Uint8Array.of(0x70, 0x77, 0xff, 0x0a),
			Uint8Array.of(0x70, 0x77, 0xc3),
		]) {
			const error = await readError(pipedBytes(bytes));
			expect(error.code).toBe("input/invalid-stdin");
			expect(error.summary).toContain("not valid UTF-8");
			expect(JSON.stringify(error.context)).not.toContain("pw");
		}
	});

	test("a leading byte-order mark is input/invalid-stdin, not silently dropped", async () => {
		const bom = Uint8Array.of(0xef, 0xbb, 0xbf, 0x70, 0x77, 0x0a);
		const error = await readError(pipedBytes(bom));
		expect(error.code).toBe("input/invalid-stdin");
		expect(error.summary).toContain("byte-order mark");
		// A U+FEFF after the first character is ordinary text and is kept.
		expect(await readPasswordStdin(piped("p\uFEFFw\n"))).toBe("p\uFEFFw");
	});

	test("a TTY stdin is refused with usage/stdin-is-tty without reading", async () => {
		let read = false;
		const error = await readError({
			isTty: true,
			read: async () => {
				read = true;
				return new TextEncoder().encode("pw\n");
			},
		});
		expect(error.code).toBe("usage/stdin-is-tty");
		expect(read).toBe(false);
	});
});

describe("devices --password-stdin argv rules", () => {
	test("--password with --password-stdin is usage/conflicting-flags and never echoes the value", async () => {
		for (const sub of ["add", "set"]) {
			const result = await runCliCaptured([
				"devices",
				sub,
				"192.0.2.5",
				"--password",
				SECRET,
				"--password-stdin",
				"--cdb-file",
				"/nonexistent/devices.cdb",
				"--json",
			]);
			expect(result.code).toBe(1);
			const envelope = JSON.parse(result.err) as { error: { code: string } };
			expect(envelope.error.code).toBe("usage/conflicting-flags");
			expect(result.err).not.toContain(SECRET);
			expect(result.out).not.toContain(SECRET);
		}
	});

	test("--password does not swallow --password-stdin as its value", async () => {
		// `--password --password-stdin` must not store the literal flag text as
		// the password; it is the same conflict as passing both flags.
		for (const sub of ["add", "set"]) {
			const result = await runCliCaptured([
				"devices",
				sub,
				"192.0.2.5",
				"--password",
				"--password-stdin",
				"--cdb-file",
				"/nonexistent/devices.cdb",
				"--json",
			]);
			expect(result.code).toBe(1);
			const envelope = JSON.parse(result.err) as { error: { code: string } };
			expect(envelope.error.code).toBe("usage/conflicting-flags");
		}
	});

	test("subcommands other than add/set refuse --password-stdin", async () => {
		const cases: string[][] = [
			["init"],
			["encrypt"],
			["list"],
			["show", "192.0.2.5"],
			["groups"],
			["edit", "192.0.2.5"],
			["remove", "192.0.2.5"],
		];
		for (const rest of cases) {
			const result = await runCliCaptured([
				"devices",
				...rest,
				"--password-stdin",
				"--cdb-file",
				"/nonexistent/devices.cdb",
				"--json",
			]);
			expect(result.code).toBe(1);
			const envelope = JSON.parse(result.err) as {
				error: { code: string; summary: string };
			};
			expect(envelope.error.code).toBe("input/invalid-command");
			expect(envelope.error.summary).toContain("--password-stdin");
		}
	});
});
