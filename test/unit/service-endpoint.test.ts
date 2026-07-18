import { describe, expect, test } from "bun:test";
import {
	type AnyServiceEndpoint,
	isEndpointAvailable,
	type ServiceEndpointMap,
} from "../../src/resolver/service-endpoint.ts";

// Anchors the neutral per-service endpoint contract (docs/CONSTITUTION.md →
// Resolution providers). These construct maps the shape a named-live-provider
// (quickchr, #134) produces, verifying the scaffold matches quickchr's published
// `ServiceEndpoint`/`SshServiceEndpoint` descriptor (docs/centrs-interface.md).

describe("isEndpointAvailable", () => {
	test("narrows an available endpoint (safe to dial)", () => {
		const endpoint: AnyServiceEndpoint = {
			available: true,
			host: "127.0.0.1",
			port: 8728,
			transport: "tcp",
			tls: false,
			source: { provider: "quickchr" },
		};
		expect(isEndpointAvailable(endpoint)).toBe(true);
		if (isEndpointAvailable(endpoint)) {
			// host/port are only reachable after the guard narrows the union.
			expect(endpoint.host).toBe("127.0.0.1");
			expect(endpoint.port).toBe(8728);
		}
	});

	test("rejects an unavailable endpoint and preserves the reason", () => {
		const endpoint: AnyServiceEndpoint = {
			available: false,
			unavailableReason: "native-api service not forwarded",
		};
		expect(isEndpointAvailable(endpoint)).toBe(false);
		if (!isEndpointAvailable(endpoint)) {
			expect(endpoint.unavailableReason).toContain("not forwarded");
		}
	});
});

describe("ServiceEndpointMap", () => {
	test("models a partial, per-via provider map (quickchr covers 3 of 8 protocols)", () => {
		const map: ServiceEndpointMap = {
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
				available: true,
				host: "127.0.0.1",
				port: 8729,
				transport: "tcp",
				tls: true,
				source: { provider: "quickchr", portMappingName: "api-ssl" },
				auth: { username: "admin", password: "secret" },
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
		};

		// A `--via` a provider doesn't supply is simply absent (a typed
		// unsupported-provider error at consume time, never a silent fallback).
		expect(map["mac-telnet"]).toBeUndefined();
		expect(Object.keys(map).sort()).toEqual(["native-api", "rest-api", "ssh"]);

		const ssh = map.ssh;
		if (
			ssh &&
			isEndpointAvailable(ssh) &&
			ssh.auth &&
			"batchModes" in ssh.auth
		) {
			// batchModes is the gate centrs enforces for --via ssh / transfer --via sftp.
			expect(ssh.auth.batchModes).toContain("private-key");
		}
	});
});
