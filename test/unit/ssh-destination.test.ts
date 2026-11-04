import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import { SftpClient } from "../../src/protocols/sftp.ts";
import { SshExecClient } from "../../src/protocols/ssh.ts";
import {
	type CdbResolution,
	parseHostCandidate,
	resolveAuth,
	resolveTarget,
} from "../../src/resolver/index.ts";
import {
	buildSshTerminalArgv,
	resolveTerminalRequest,
} from "../../src/terminal.ts";

const base = { host: "192.0.2.10", port: 2222, timeoutMs: 5000 };
const command = "/system/identity/print";
const terminal = await resolveTerminalRequest(
	{ host: base.host, port: base.port, via: "ssh" },
	{},
);
const builders = {
	execute: (host: string, username?: string) =>
		new SshExecClient({ ...base, host, username }).argv(command),
	sftp: (host: string, username?: string) =>
		new SftpClient({ ...base, host, username }).argv(),
	terminal: (host: string, username?: string) =>
		buildSshTerminalArgv({
			...terminal,
			target: { ...terminal.target, host },
			auth: { ...terminal.auth, username },
		}),
};

for (const [name, build] of Object.entries(builders)) {
	describe(`${name} destination boundary`, () => {
		for (const host of ["192.0.2.10", "2001:db8::10", "edge-router.example"]) {
			for (const username of [undefined, "admin"]) {
				test(`${host}, user ${username ?? "unset"}: destination follows --`, () => {
					const formatted =
						name === "sftp" && host.includes(":") ? `[${host}]` : host;
					const destination = `${username ? `${username}@` : ""}${formatted}`;
					const argv = build(host, username);
					expect(argv.slice(argv.indexOf("--"))).toEqual(
						name === "execute"
							? ["--", destination, command]
							: ["--", destination],
					);
				});
			}
		}
		for (const field of ["host", "username"] as const) {
			for (const value of ["-", "--help", "-edge:22"]) {
				test(`rejects option-like ${field} ${value}`, () => {
					try {
						build(
							field === "host" ? value : base.host,
							field === "username" ? value : "admin",
						);
						throw new Error("expected refusal");
					} catch (error) {
						expect(error).toBeInstanceOf(CentrsError);
						expect(error).toMatchObject({
							code: "input/invalid-target",
							context: { field },
						});
						if (error instanceof CentrsError) {
							expect(error.remediation).toContain("do not start");
							expect(error.context).toEqual({ field });
						}
					}
				});
			}
		}
	});
}

const cdb: CdbResolution = {
	target: base.host,
	identity: "fixture",
	username: "admin",
	password: "fixture-secret",
	recordIndex: 0,
	overrides: {},
	warnings: [],
};

describe("resolver host labels", () => {
	for (const host of [
		"-edge",
		"edge.-site.example",
		"http://-edge:8080",
		"https://edge.%2dsite.example",
	]) {
		test(`rejects ${host} after URL normalization`, () => {
			expect(() => parseHostCandidate(host)).toThrow(CentrsError);
			expect(() => resolveTarget({ host }, {}, "ssh")).toThrow(
				"A host label must not start with a hyphen",
			);
		});
	}
	test("all resolver host sources share the rejection", () => {
		for (const resolve of [
			() => resolveTarget({ targetInput: "-edge" }, {}, "ssh"),
			() => resolveTarget({}, { CENTRS_HOST: "-edge" }, "ssh"),
			() => resolveTarget({}, {}, "ssh", { ...cdb, target: "-edge" }),
			() => resolveTarget({}, {}, "ssh", undefined, { CENTRS_HOST: "-edge" }),
		]) {
			expect(resolve).toThrow("A host label must not start with a hyphen");
		}
	});
	test("environment and stored usernames are checked at each argv boundary", () => {
		for (const auth of [
			resolveAuth({}, { CENTRS_USERNAME: "-user" }),
			resolveAuth({}, {}, { ...cdb, username: "-user" }),
			resolveAuth(
				{},
				{},
				{
					...cdb,
					username: "",
					defaults: { username: "-user", recordIndex: 1 },
				},
			),
		]) {
			for (const build of Object.values(builders)) {
				expect(() => build(base.host, auth.username)).toThrow(CentrsError);
			}
		}
	});
	test("normal names, addresses and IPv6 brackets remain valid", () => {
		for (const host of [
			"edge-router.example",
			"192.0.2.10",
			"2001:db8::10",
			"[2001:db8::10]:2222",
		]) {
			expect(resolveTarget({ host }, {}, "ssh").host).toBe(
				host.startsWith("[") ? "2001:db8::10" : host,
			);
		}
	});
});
