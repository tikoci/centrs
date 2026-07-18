import { describe, expect, test } from "bun:test";
import { CentrsError, type CentrsErrorCode } from "../../src/errors.ts";
import {
	isEndpointAvailable,
	resolveQuickchrTarget,
} from "../../src/resolver/index.ts";

// Anchors the quickchr named-live-provider resolution core (#134 Phase 2). The
// `load` seam stands in for the runtime-specifier `import("@tikoci/quickchr")`,
// so these exercise the descriptor→ServiceEndpointMap mapping and the typed
// `quickchr/*` error surface without a real quickchr install or a live VM.

function descriptorFor(name: string) {
	return {
		descriptorVersion: 1,
		quickchr: { packageVersion: "0.4.4" },
		status: "running",
		name,
		version: "7.23.1",
		arch: "x86_64",
		services: {
			"rest-api": {
				available: true,
				host: "127.0.0.1",
				port: 44300,
				transport: "tcp",
				tls: true,
				url: "https://127.0.0.1:44300",
				source: { provider: "quickchr", portMappingName: "https" },
				auth: { username: "admin", password: "secret" },
			},
			"native-api": {
				available: false,
				unavailableReason: "api-ssl not forwarded",
			},
			ssh: {
				available: true,
				host: "127.0.0.1",
				port: 22000,
				transport: "tcp",
				tls: false,
				source: { provider: "quickchr" },
				auth: {
					username: "admin",
					privateKeyPath: "/tmp/quickchr/lab/id_ed25519",
					modes: ["private-key", "agent-or-config"],
					batchModes: ["private-key"],
				},
			},
			// A future/unknown service key centrs does not map — must be ignored.
			"winbox-terminal-future": { available: true },
		},
	};
}

function moduleWith(get: (name: string) => unknown) {
	return async () => ({ QuickCHR: { get } }) as never;
}

async function expectCode(promise: Promise<unknown>, code: CentrsErrorCode) {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(CentrsError);
		expect((error as CentrsError).code).toBe(code);
		return error as CentrsError;
	}
	throw new Error(`expected a CentrsError ${code}, but it resolved`);
}

describe("resolveQuickchrTarget", () => {
	test("maps a running descriptor into a per-via ServiceEndpointMap", async () => {
		const resolution = await resolveQuickchrTarget(
			"lab",
			moduleWith((name) => ({ descriptor: async () => descriptorFor(name) })),
		);
		expect(resolution.name).toBe("lab");
		expect(resolution.routerOsVersion).toBe("7.23.1");
		expect(resolution.arch).toBe("x86_64");
		expect(resolution.packageVersion).toBe("0.4.4");
		// Only known `--via` protocols are carried; the unknown key is dropped.
		expect(Object.keys(resolution.services).sort()).toEqual([
			"native-api",
			"rest-api",
			"ssh",
		]);
		const rest = resolution.services["rest-api"];
		expect(rest && isEndpointAvailable(rest) && rest.port).toBe(44300);
		// An unavailable service is preserved (the consumer gates on `available`).
		expect(resolution.services["native-api"]?.available).toBe(false);
	});

	test("package missing → quickchr/package-unavailable", async () => {
		const err = await expectCode(
			resolveQuickchrTarget("lab", async () => {
				throw new Error("Cannot find module '@tikoci/quickchr'");
			}),
			"quickchr/package-unavailable",
		);
		expect(err.remediation).toContain("bun add");
	});

	test("old quickchr without QuickCHR.get → quickchr/unsupported", async () => {
		await expectCode(
			resolveQuickchrTarget("lab", async () => ({}) as never),
			"quickchr/unsupported",
		);
	});

	test("unknown machine (get returns null) → quickchr/machine-not-found", async () => {
		await expectCode(
			resolveQuickchrTarget(
				"ghost",
				moduleWith(() => null),
			),
			"quickchr/machine-not-found",
		);
	});

	test("stopped machine (descriptor throws MACHINE_STOPPED) → quickchr/machine-stopped", async () => {
		const err = await expectCode(
			resolveQuickchrTarget(
				"lab",
				moduleWith(() => ({
					descriptor: async () => {
						throw { code: "MACHINE_STOPPED", message: "not running" };
					},
				})),
			),
			"quickchr/machine-stopped",
		);
		expect(err.remediation).toContain("quickchr start");
	});

	test("descriptor MACHINE_NOT_FOUND throw also maps to machine-not-found", async () => {
		await expectCode(
			resolveQuickchrTarget(
				"lab",
				moduleWith(() => ({
					descriptor: async () => {
						throw { code: "MACHINE_NOT_FOUND" };
					},
				})),
			),
			"quickchr/machine-not-found",
		);
	});

	test("newer descriptor version → quickchr/unsupported", async () => {
		await expectCode(
			resolveQuickchrTarget(
				"lab",
				moduleWith((name) => ({
					descriptor: async () => ({
						...descriptorFor(name),
						descriptorVersion: 2,
					}),
				})),
			),
			"quickchr/unsupported",
		);
	});

	test("pre-v1 descriptor without descriptorVersion → quickchr/unsupported (not a raw TypeError)", async () => {
		// An old-shaped descriptor with no descriptorVersion and no `services` must
		// be rejected with a typed error, never crash on `Object.entries(undefined)`.
		await expectCode(
			resolveQuickchrTarget(
				"lab",
				moduleWith(() => ({
					descriptor: async () => ({
						name: "lab",
						version: "7.23.1",
						arch: "x86_64",
					}),
				})),
			),
			"quickchr/unsupported",
		);
	});

	test("v1 descriptor missing services map → quickchr/unsupported (no silent empty map)", async () => {
		await expectCode(
			resolveQuickchrTarget(
				"lab",
				moduleWith((name) => {
					const { services: _drop, ...rest } = descriptorFor(name);
					return { descriptor: async () => rest };
				}),
			),
			"quickchr/unsupported",
		);
	});

	test("non-object descriptor → quickchr/unsupported", async () => {
		await expectCode(
			resolveQuickchrTarget(
				"lab",
				moduleWith(() => ({ descriptor: async () => null })),
			),
			"quickchr/unsupported",
		);
	});

	test("installed package that throws on load → quickchr/unsupported (not package-unavailable)", async () => {
		// A module-evaluation failure is a real fault, not a missing optional dep.
		await expectCode(
			resolveQuickchrTarget("lab", async () => {
				throw new Error("boom during module evaluation");
			}),
			"quickchr/unsupported",
		);
	});

	test("installed quickchr with a missing *transitive* import → quickchr/unsupported (not package-unavailable)", async () => {
		// Same ERR_MODULE_NOT_FOUND code, but the missing specifier is a transitive
		// dep of an installed quickchr — must not be mislabeled "not installed".
		await expectCode(
			resolveQuickchrTarget("lab", async () => {
				throw Object.assign(
					new Error(
						"Cannot find package 'left-pad' imported from /node_modules/@tikoci/quickchr/src/index.ts",
					),
					{ code: "ERR_MODULE_NOT_FOUND" },
				);
			}),
			"quickchr/unsupported",
		);
	});

	test("quickchr itself not resolvable (ERR_MODULE_NOT_FOUND for the package) → quickchr/package-unavailable", async () => {
		await expectCode(
			resolveQuickchrTarget("lab", async () => {
				throw Object.assign(
					new Error("Cannot find package '@tikoci/quickchr'"),
					{ code: "ERR_MODULE_NOT_FOUND" },
				);
			}),
			"quickchr/package-unavailable",
		);
	});
});
