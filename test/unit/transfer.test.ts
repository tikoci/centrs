import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CentrsError,
	normalizeRemotePath,
	selectTransferMethod,
	type TransferRequest,
	type TransferSuccessEnvelope,
	transfer,
	validateTransferRequestShape,
} from "../../src/index.ts";

// ── fetch mock (drives the REST adapter end-to-end, no CHR) ──────────────────

type FetchHandler = (
	url: string,
	init: RequestInit | undefined,
) => Response | Promise<Response>;

function mockFetchSequence(handlers: readonly FetchHandler[]) {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const queue = [...handlers];
	const originalFetch = globalThis.fetch;

	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		calls.push({ url, init });
		const handler = queue.shift();
		if (!handler) {
			throw new Error(`Unexpected fetch call for ${url}`);
		}
		return handler(url, init);
	}) as typeof fetch;

	return {
		calls,
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
}

const json = (value: unknown) => new Response(JSON.stringify(value));

const TMP = mkdtempSync(join(tmpdir(), "centrs-transfer-"));
function tmpFile(name: string, contents: string | Buffer): string {
	const path = join(TMP, name);
	writeFileSync(path, contents);
	return path;
}

function baseRequest(overrides: Partial<TransferRequest>): TransferRequest {
	return {
		verb: "list",
		targetInput: "router1",
		host: "127.0.0.1",
		port: 9999,
		username: "admin",
		password: "",
		...overrides,
	};
}

async function runTransfer(
	request: TransferRequest,
): Promise<TransferSuccessEnvelope> {
	return transfer(request, {});
}

// ── pure: path normalization ─────────────────────────────────────────────────

describe("normalizeRemotePath", () => {
	test("strips a leading slash and collapses doubles", () => {
		expect(normalizeRemotePath("/flash/x")).toBe("flash/x");
		expect(normalizeRemotePath("flash/x")).toBe("flash/x");
		expect(normalizeRemotePath("//flash//x")).toBe("flash/x");
		expect(normalizeRemotePath("x.txt")).toBe("x.txt");
	});
});

// ── pure: method selection + gating ──────────────────────────────────────────

describe("selectTransferMethod", () => {
	test("auto picks rest for reads and small writes", () => {
		expect(
			selectTransferMethod(
				baseRequest({ verb: "download" }),
				"download",
				undefined,
				{},
			),
		).toMatchObject({ method: "rest", protocol: "rest-api" });
		expect(
			selectTransferMethod(baseRequest({ verb: "upload" }), "upload", 1024, {}),
		).toMatchObject({ method: "rest", protocol: "rest-api" });
	});

	test("auto upload over 60 KB auto-selects sftp", () => {
		expect(
			selectTransferMethod(
				baseRequest({ verb: "upload" }),
				"upload",
				70_000,
				{},
			),
		).toMatchObject({ method: "sftp", protocol: "ssh" });
	});

	test("explicit rest / native map to their grid protocol", () => {
		expect(
			selectTransferMethod(
				baseRequest({ via: "rest" }),
				"download",
				undefined,
				{},
			),
		).toMatchObject({ method: "rest", protocol: "rest-api" });
		expect(
			selectTransferMethod(
				baseRequest({ via: "native" }),
				"download",
				undefined,
				{},
			),
		).toMatchObject({ method: "native", protocol: "native-api" });
	});

	test("sftp routes to the ssh transport", () => {
		expect(
			selectTransferMethod(baseRequest({ via: "sftp" }), "upload", 10, {}),
		).toMatchObject({ method: "sftp", protocol: "ssh" });
	});

	test("scp / fetch are not implemented yet", () => {
		for (const via of ["scp", "fetch"]) {
			let code = "";
			try {
				selectTransferMethod(baseRequest({ via }), "upload", 10, {});
			} catch (error) {
				code = (error as CentrsError).code;
			}
			expect(code).toBe("usage/not-implemented");
		}
	});

	test("ftp is gated unless ALLOW_UNSAFE_PROTOCOLS=ftp", () => {
		let blocked = "";
		try {
			selectTransferMethod(baseRequest({ via: "ftp" }), "upload", 10, {});
		} catch (error) {
			blocked = (error as CentrsError).code;
		}
		expect(blocked).toBe("settings/unsafe-protocol-blocked");

		let allowed = "";
		try {
			selectTransferMethod(baseRequest({ via: "ftp" }), "upload", 10, {
				ALLOW_UNSAFE_PROTOCOLS: "ftp",
			});
		} catch (error) {
			allowed = (error as CentrsError).code;
		}
		expect(allowed).toBe("usage/not-implemented");
	});
});

// ── pure: request-shape validation ───────────────────────────────────────────

describe("validateTransferRequestShape", () => {
	test("upload requires a local source", () => {
		expect(() =>
			validateTransferRequestShape({ verb: "upload", remote: "x.txt" }),
		).toThrow();
	});

	test("mkdir / remove require a remote path", () => {
		expect(() => validateTransferRequestShape({ verb: "mkdir" })).toThrow();
		expect(() => validateTransferRequestShape({ verb: "remove" })).toThrow();
	});

	test("copy requires source and destination", () => {
		expect(() =>
			validateTransferRequestShape({ verb: "copy", remote: "a.txt" }),
		).toThrow();
	});

	test("a bad --verify value is rejected", () => {
		expect(() =>
			validateTransferRequestShape({
				verb: "upload",
				local: "x",
				remote: "y",
				verify: "bogus",
			}),
		).toThrow();
	});

	test("download with an omitted local is allowed", () => {
		expect(() =>
			validateTransferRequestShape({ verb: "download", remote: "x.txt" }),
		).not.toThrow();
	});
});

// ── orchestration: upload small (REST round-trip wire shape) ──────────────────

describe("transfer upload (rest)", () => {
	test("creates, writes contents, and verifies size", async () => {
		const local = tmpFile("up.txt", "hello-centrs");
		const fetchMock = mockFetchSequence([
			() => json([]), // findFile pre-add: not present
			() => json({ ret: "*5" }), // add → new id
			() => json({}), // set contents
			() =>
				json([{ ".id": "*5", name: "dst.txt", type: ".txt file", size: "12" }]), // verify print
		]);
		try {
			const envelope = await runTransfer(
				baseRequest({ verb: "upload", local, remote: "dst.txt" }),
			);
			expect(envelope.ok).toBe(true);
			expect(envelope.data).toMatchObject({
				op: "upload",
				remote: "dst.txt",
				bytes: 12,
				verified: "size",
				method: "rest",
			});
			expect(envelope.meta.via).toBe("rest-api");
			const paths = fetchMock.calls.map((c) => new URL(c.url).pathname);
			expect(paths).toEqual([
				"/rest/file/print",
				"/rest/file/add",
				"/rest/file/set",
				"/rest/file/print",
			]);
			// the set call carried the .id and contents
			const setBody = JSON.parse(String(fetchMock.calls[2]?.init?.body));
			expect(setBody).toMatchObject({ ".id": "*5", contents: "hello-centrs" });
		} finally {
			fetchMock.restore();
		}
	});

	test("refuses an existing target without --force", async () => {
		const local = tmpFile("up2.txt", "hi");
		const fetchMock = mockFetchSequence([
			() =>
				json([{ ".id": "*7", name: "dst.txt", type: ".txt file", size: "2" }]),
		]);
		try {
			let code = "";
			try {
				await runTransfer(
					baseRequest({ verb: "upload", local, remote: "dst.txt" }),
				);
			} catch (error) {
				code = (error as CentrsError).code;
			}
			expect(code).toBe("usage/target-exists");
			// only the existence probe ran — no add/set
			expect(fetchMock.calls).toHaveLength(1);
		} finally {
			fetchMock.restore();
		}
	});

	test("rejects a >60 KB write over rest before any network call", async () => {
		const local = tmpFile("big.bin", Buffer.alloc(70_000, 1));
		const fetchMock = mockFetchSequence([]);
		try {
			let code = "";
			try {
				await runTransfer(
					baseRequest({
						verb: "upload",
						via: "rest",
						local,
						remote: "big.bin",
					}),
				);
			} catch (error) {
				code = (error as CentrsError).code;
			}
			expect(code).toBe("transport/unsupported-operation");
			expect(fetchMock.calls).toHaveLength(0);
		} finally {
			fetchMock.restore();
		}
	});
});

// ── orchestration: download small ────────────────────────────────────────────

describe("transfer download (rest)", () => {
	test("reads contents and writes the local file", async () => {
		const out = join(TMP, "down.txt");
		const fetchMock = mockFetchSequence([
			() =>
				json([{ ".id": "*9", name: "src.txt", type: ".txt file", size: "12" }]),
			() => json({ ret: "hello-centrs" }),
		]);
		try {
			const envelope = await runTransfer(
				baseRequest({ verb: "download", remote: "src.txt", local: out }),
			);
			expect(envelope.ok).toBe(true);
			expect(envelope.data).toMatchObject({ op: "download", bytes: 12 });
			expect(readFileSync(out, "utf8")).toBe("hello-centrs");
			const paths = fetchMock.calls.map((c) => new URL(c.url).pathname);
			expect(paths).toEqual(["/rest/file/print", "/rest/file/get"]);
		} finally {
			fetchMock.restore();
		}
	});

	test("a missing remote file is a routeros error", async () => {
		const fetchMock = mockFetchSequence([() => json([])]);
		try {
			let code = "";
			try {
				await runTransfer(
					baseRequest({
						verb: "download",
						remote: "nope.txt",
						local: join(TMP, "x"),
					}),
				);
			} catch (error) {
				code = (error as CentrsError).code;
			}
			expect(code).toBe("routeros/command-failed");
		} finally {
			fetchMock.restore();
		}
	});
});

// ── orchestration: list + filters ────────────────────────────────────────────

describe("transfer list", () => {
	const rows = [
		{ ".id": "*1", name: "a.txt", type: ".txt file", size: "10" },
		{ ".id": "*2", name: "logs", type: "directory" },
		{ ".id": "*3", name: "b.rsc", type: ".rsc file", size: "20" },
	];

	test("returns the /file rows", async () => {
		const fetchMock = mockFetchSequence([() => json(rows)]);
		try {
			const envelope = await runTransfer(baseRequest({ verb: "list" }));
			expect(Array.isArray(envelope.data)).toBe(true);
			expect(envelope.data).toHaveLength(3);
			expect(new URL(String(fetchMock.calls[0]?.url)).pathname).toBe(
				"/rest/file/print",
			);
		} finally {
			fetchMock.restore();
		}
	});

	test("--type file excludes directories", async () => {
		const fetchMock = mockFetchSequence([() => json(rows)]);
		try {
			const envelope = await runTransfer(
				baseRequest({ verb: "list", type: "file" }),
			);
			const names = (envelope.data as Record<string, unknown>[]).map(
				(r) => r["name"],
			);
			expect(names).toEqual(["a.txt", "b.rsc"]);
		} finally {
			fetchMock.restore();
		}
	});

	test("--name glob filters by name", async () => {
		const fetchMock = mockFetchSequence([() => json(rows)]);
		try {
			const envelope = await runTransfer(
				baseRequest({ verb: "list", name: "*.rsc" }),
			);
			const names = (envelope.data as Record<string, unknown>[]).map(
				(r) => r["name"],
			);
			expect(names).toEqual(["b.rsc"]);
		} finally {
			fetchMock.restore();
		}
	});
});

// cleanup the temp dir once the process exits
process.on("exit", () => {
	try {
		rmSync(TMP, { recursive: true, force: true });
	} catch {
		// best effort
	}
});
