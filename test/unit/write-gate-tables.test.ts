import { describe, expect, test } from "bun:test";
import { isApiMutating } from "../../src/api.ts";
import {
	canonicalizeExecuteCommand,
	isWriteShaped,
} from "../../src/core/execute-command.ts";
import { ROOT_CMDS } from "../../src/explain/write.ts";

/**
 * The write gate's decision tables: what needs `--yes` (and what MCP `mcp=ro`
 * refuses). A false "write" only costs `--yes`; a false "read" lets a mutation
 * through, so every "read" row here was argued, not assumed.
 */

function writes(input: string): boolean {
	return isWriteShaped(canonicalizeExecuteCommand(input));
}

/**
 * #458: one row per root cmd in `explain`'s grounded vocabulary, so a newly
 * grounded directive fails the key check below until someone decides it.
 * `read` rows are output, control flow and pure value functions; everything
 * that changes state, runs built code or outlives the script stays `write`,
 * as does anything not argued read (`beep`, `resolve`, `ping`, …).
 */
const DIRECTIVES: Record<string, "read" | "write"> = {
	beep: "write",
	break: "read",
	continue: "read",
	convert: "read",
	delay: "read",
	deserialize: "read",
	do: "read",
	error: "read",
	execute: "write",
	exit: "write",
	export: "write",
	find: "read",
	for: "read",
	foreach: "read",
	global: "write",
	grep: "write",
	if: "read",
	import: "write",
	jobname: "read",
	len: "read",
	local: "read",
	lock: "write",
	nothing: "read",
	onerror: "read",
	parse: "write",
	password: "write",
	pick: "read",
	ping: "write",
	put: "read",
	quit: "write",
	range: "read",
	"recursive-print": "write",
	redo: "write",
	resolve: "write",
	retry: "read",
	return: "read",
	rndnum: "read",
	rndstr: "read",
	serialize: "read",
	set: "write",
	time: "read",
	timestamp: "read",
	toarray: "read",
	tobool: "read",
	tocrlf: "read",
	toid: "read",
	toip: "read",
	toip6: "read",
	tolf: "read",
	tonsec: "read",
	tonum: "read",
	tostr: "read",
	totime: "read",
	typeof: "read",
	undo: "write",
	while: "read",
};

describe("script directives: read or write (#458)", () => {
	test("the table covers exactly the grounded root-cmd vocabulary", () => {
		expect(Object.keys(DIRECTIVES).sort()).toEqual([...ROOT_CMDS].sort());
	});

	for (const [name, expected] of Object.entries(DIRECTIVES)) {
		test(`:${name} is a ${expected}`, () => {
			expect(writes(`:${name} value=1`)).toBe(expected === "write");
		});
	}

	test("the field run's structured reads need no --yes", () => {
		expect(
			writes(":put [:serialize to=json [/system/resource/print as-value]]"),
		).toBe(false);
		expect(writes(":delay 15s; :put done")).toBe(false);
		expect(
			writes(
				":put [:convert from=raw to=base64 value=[/system/identity/get name]]",
			),
		).toBe(false);
	});

	test("a pure function's output redirect is a write: :serialize file-name=", () => {
		expect(writes(":serialize to=json value=1 file-name=out.json")).toBe(true);
		expect(
			writes(":put [:serialize to=json file-name=out value=[:toarray 1]]"),
		).toBe(true);
		// The same redirect under a read verb in structured mode.
		expect(writes("/export file-name=x")).toBe(true);
	});

	test("the absolute `/name` spelling of a root directive is the directive", () => {
		expect(writes("/serialize to=json value=1")).toBe(false);
		expect(writes("/delay 1s")).toBe(false);
		expect(writes("/put [/system/identity/get name]")).toBe(false);
		// Its body and redirect rules still apply.
		expect(writes("/put [/system/reboot]")).toBe(true);
		expect(writes("/serialize to=json value=1 file-name=x")).toBe(true);
		// A root write keeps its write class in either spelling.
		expect(writes("/global g 1")).toBe(true);
		expect(writes("/execute {/system/reboot}")).toBe(true);
	});

	test("a bare directive word keeps the menu-verb rule (it may be relative)", () => {
		// After `/ip address`, a bare word names a menu command, so the gate
		// cannot tell a root directive from a relative command. Fails closed.
		expect(writes("delay 1s")).toBe(true);
		expect(writes("/ip address\nserialize to=json value=1")).toBe(true);
	});

	test("a write in a control-flow body is still a write", () => {
		// RouterOS runs only a `{…}` block in a script-typed argument (a quoted
		// string is refused, CHR 7.24.5 and 7.26beta1), and each block is checked.
		expect(writes(":retry command={/system/reboot} max=1 delay=1s")).toBe(true);
		expect(writes(":time {/user/add name=x group=read}")).toBe(true);
		expect(writes(":do {:delay 1s} on-error={/system/reboot}")).toBe(true);
		expect(writes(":retry command={:put 1} max=1 delay=1s")).toBe(false);
	});

	test("a write inside a pure function's argument is still a write", () => {
		expect(writes(":delay 1s; /system/reboot")).toBe(true);
		expect(
			writes(":put [:serialize to=json [/ip/address/add address=1.2.3.4/32]]"),
		).toBe(true);
		expect(writes(":put [:tostr [/user/add name=x group=read]]")).toBe(true);
	});
});

/**
 * #456: on 7.26beta1 a controller login with `read` + `api` can run fleet
 * writes through `/cmr/device/run-script` (and `read` + `test` + `api`,
 * reboots), so RouterOS policy is no barrier. centrs' classification is the
 * only one, and MCP `mcp=ro` rests on it. Every spelling stays a write.
 */
const FLEET_COMMANDS: readonly string[] = [
	'/cmr/device/run-script numbers=0 script=":put 1"',
	"/cmr/device/reboot numbers=0",
	"/cmr/device/upgrade numbers=0",
	"/cmr/device/pair numbers=0",
	"/cmr/upgrade/trigger",
	"/cmr/upgrade/job/run-next",
	// Space-separated menu spelling.
	'/cmr device run-script labels=all script=":put 1"',
	"/cmr device reboot labels=all",
	"/cmr upgrade trigger",
	// Abbreviations RouterOS accepts.
	"/cmr/dev/reb numbers=0",
	'/cmr/dev/run-s numbers=0 script=":put 1"',
	"/cmr/up/trigger",
	// Script forms: inside a block, a bracket, a loop, and relative navigation.
	'/cmr/device { run-script numbers=0 script=":put 1" }',
	':put [/cmr/device/run-script numbers=0 script=":put 1"]',
	":foreach d in=[/cmr/device/find] do={/cmr/device/reboot numbers=$d}",
	"/cmr/device\nreboot numbers=0",
	// A read-looking script body does not make run-script a read.
	"/cmr/device/run-script numbers=0 script=print",
];

describe("CMR fleet commands are always writes (#456)", () => {
	for (const command of FLEET_COMMANDS) {
		test(`execute: ${command.replaceAll("\n", "\\n")}`, () => {
			expect(writes(command)).toBe(true);
		});
	}

	for (const path of [
		"/cmr/device/run-script",
		"/cmr/device/reboot",
		"/cmr/device/upgrade",
		"/cmr/device/pair",
		"/cmr/upgrade/trigger",
		"/cmr/upgrade/job/run-next",
		"/cmr/dev/run-s",
	]) {
		test(`api POST ${path}`, () => {
			expect(isApiMutating("POST", path)).toBe(true);
		});
	}

	test("reading the fleet stays a read", () => {
		expect(writes("/cmr/device/print")).toBe(false);
		expect(isApiMutating("GET", "/cmr/device")).toBe(false);
	});
});

describe("api: POST /console/inspect is a read (#458)", () => {
	test("POST to the exact path is a read", () => {
		expect(isApiMutating("POST", "/console/inspect")).toBe(false);
		expect(isApiMutating("POST", "console/inspect")).toBe(false);
	});

	test("PUT, PATCH and DELETE (add/set/remove) stay writes", () => {
		for (const method of ["PUT", "PATCH", "DELETE"] as const) {
			expect(isApiMutating(method, "/console/inspect")).toBe(true);
		}
	});

	test("an abbreviation or a deeper path stays a write", () => {
		expect(isApiMutating("POST", "/con/insp")).toBe(true);
		expect(isApiMutating("POST", "/console/inspect/x")).toBe(true);
		expect(isApiMutating("POST", "/console/clear-history")).toBe(true);
	});
});
