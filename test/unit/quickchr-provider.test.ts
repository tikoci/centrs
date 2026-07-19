import { describe, expect, test } from "bun:test";
import { CentrsError, type CentrsErrorCode } from "../../src/errors.ts";
import {
	assertNoQuickchrOverrideConflict,
	isEndpointAvailable,
	quickchrConnection,
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

async function resolutionFor(name = "lab") {
	return resolveQuickchrTarget(
		name,
		moduleWith((machine) => ({
			descriptor: async () => descriptorFor(machine),
		})),
	);
}

function expectThrowCode(
	fn: () => unknown,
	code: CentrsErrorCode,
): CentrsError {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(CentrsError);
		expect((error as CentrsError).code).toBe(code);
		return error as CentrsError;
	}
	throw new Error(`expected a CentrsError ${code}, but it returned`);
}

describe("quickchrConnection (per-`--via` consumption, #134 Phase 4)", () => {
	test("rest-api: endpoint → ResolvedTarget/ResolvedAuth with provider provenance", async () => {
		const { target, auth } = quickchrConnection(
			await resolutionFor(),
			"rest-api",
		);
		expect(target.host).toBe("127.0.0.1");
		expect(target.port).toBe(44300);
		expect(target.tls).toBe(true);
		expect(target.baseUrl).toBe("https://127.0.0.1:44300/rest");
		expect(target.identity).toBe("lab");
		expect(target.input).toBe("lab");
		// No CDB was consulted, so no record index may leak into the envelope.
		expect(target.recordIndex).toBeUndefined();
		expect(target.source).toEqual({ kind: "provider", key: "quickchr:lab" });
		expect(target.sources["host"]).toEqual({
			kind: "provider",
			key: "quickchr:lab",
		});
		expect(auth.username).toBe("admin");
		expect(auth.password).toBe("secret");
		expect(auth.passwordProvided).toBe(true);
		expect(auth.usernameSource?.kind).toBe("provider");
	});

	test("ssh: batch-capable endpoint → sshKey from privateKeyPath, never a password", async () => {
		const { target, auth } = quickchrConnection(await resolutionFor(), "ssh");
		expect(target.port).toBe(22000);
		expect(target.tls).toBe(false);
		expect(target.baseUrl).toBe("ssh://127.0.0.1:22000");
		expect(auth.username).toBe("admin");
		expect(auth.sshKey).toBe("/tmp/quickchr/lab/id_ed25519");
		expect(auth.sshKeySource?.kind).toBe("provider");
		expect(auth.passwordProvided).toBe(false);
		expect(auth.password).toBe("");
	});

	test("unavailable service → quickchr/unsupported-via with the provider's reason", async () => {
		const resolution = await resolutionFor();
		const error = expectThrowCode(
			() => quickchrConnection(resolution, "native-api"),
			"quickchr/unsupported-via",
		);
		expect(error.context?.["unavailableReason"]).toBe("api-ssl not forwarded");
		// The remediation names the machine's live services.
		expect(error.context?.["availableServices"]).toEqual(["rest-api", "ssh"]);
	});

	test("service the descriptor does not forward (mac-telnet) → quickchr/unsupported-via", async () => {
		const resolution = await resolutionFor();
		expectThrowCode(
			() => quickchrConnection(resolution, "mac-telnet"),
			"quickchr/unsupported-via",
		);
	});

	test("ssh with no batch-capable auth mode → quickchr/unsupported-via (sftp gate)", async () => {
		const descriptor = descriptorFor("lab");
		(
			descriptor.services.ssh as { auth: { batchModes: string[] } }
		).auth.batchModes = [];
		const resolution = await resolveQuickchrTarget(
			"lab",
			moduleWith(() => ({ descriptor: async () => descriptor })),
		);
		const error = expectThrowCode(
			() => quickchrConnection(resolution, "ssh"),
			"quickchr/unsupported-via",
		);
		// The alternatives never re-suggest the `--via` that just failed.
		expect(error.context?.["availableServices"]).toEqual(["rest-api"]);
	});

	test("ssh private-key batch mode WITHOUT a key path → quickchr/unsupported-via (no ambient fallback)", async () => {
		const descriptor = descriptorFor("lab");
		const sshAuth = descriptor.services.ssh as {
			auth: { privateKeyPath?: string; batchModes: string[] };
		};
		// A `private-key` batch mode with no path would let the SSH client fall
		// back to whatever ambient agent/config offers — reject it as unusable.
		sshAuth.auth.privateKeyPath = undefined;
		sshAuth.auth.batchModes = ["private-key"];
		const resolution = await resolveQuickchrTarget(
			"lab",
			moduleWith(() => ({ descriptor: async () => descriptor })),
		);
		const error = expectThrowCode(
			() => quickchrConnection(resolution, "ssh"),
			"quickchr/unsupported-via",
		);
		// The unusable ssh endpoint is not advertised as an alternative either.
		expect(error.context?.["availableServices"]).toEqual(["rest-api"]);
	});

	test("ssh batch-capable via agent-or-config only → connection without sshKey", async () => {
		const descriptor = descriptorFor("lab");
		const sshAuth = descriptor.services.ssh as {
			auth: { privateKeyPath?: string; batchModes: string[] };
		};
		sshAuth.auth.privateKeyPath = undefined;
		sshAuth.auth.batchModes = ["agent-or-config"];
		const resolution = await resolveQuickchrTarget(
			"lab",
			moduleWith(() => ({ descriptor: async () => descriptor })),
		);
		const { auth } = quickchrConnection(resolution, "ssh");
		expect(auth.sshKey).toBeUndefined();
		expect(auth.username).toBe("admin");
	});
});

describe("assertNoQuickchrOverrideConflict (#134 override rule)", () => {
	test("no overrides → passes", () => {
		expect(() => assertNoQuickchrOverrideConflict({}, "lab")).not.toThrow();
	});

	test("each direct override flag conflicts", () => {
		for (const request of [
			{ host: "192.0.2.1" },
			{ port: 8729 },
			{ username: "admin" },
			{ password: "x" },
			{ sshKey: "/tmp/key" },
		]) {
			const error = expectThrowCode(
				() => assertNoQuickchrOverrideConflict(request, "lab"),
				"usage/conflicting-flags",
			);
			expect(error.summary).toContain("--quickchr lab");
		}
	});

	test("lists every conflicting flag at once", () => {
		const error = expectThrowCode(
			() =>
				assertNoQuickchrOverrideConflict(
					{ host: "192.0.2.1", password: "x" },
					"lab",
				),
			"usage/conflicting-flags",
		);
		expect(error.context?.["conflicts"]).toEqual(["--host", "--password"]);
	});
});
