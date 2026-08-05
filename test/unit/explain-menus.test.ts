/**
 * Anchor tests for the baked RouterOS menu table (#207) and for the
 * `isConfirmedNav` behaviour it enables.
 *
 * The table is GENERATED (`bun run explain:menus`), so these are not tests of
 * the generator's arithmetic — `bun run explain:menus --check` is the drift
 * gate for that, and it needs network, so it hangs off QA rather than the
 * offline gate. What is pinned here is the CONTRACT the table has to satisfy
 * for `write.ts` to be allowed to trust it, stated as the cases #207 was filed
 * on:
 *
 *   - every menu the hyphen heuristic wrongly refused is present;
 *   - none of the commands the hyphen heuristic existed to protect is present;
 *   - an unknown path still abstains, so a stale or incomplete table degrades
 *     to the pre-#207 behaviour rather than to a wrong answer.
 *
 * The first two are the ones a bad regeneration would break, and the second is
 * the dangerous direction: a menu missing costs precision, a command wrongly
 * listed costs correctness.
 */

import { describe, expect, test } from "bun:test";
import { isMenuPath, MENU_PATHS } from "../../src/explain/menus.ts";
import { containsWrite } from "../../src/explain/write.ts";

/**
 * Every menu the old rule refused on the #203 export stratum — 25 distinct
 * menus, 100% of the Q16 abstentions in the whole stratum, all proven menus
 * because the device's own verbose export navigated into each one and then
 * emitted a relative `add`/`set`.
 */
const EXPORT_STRATUM_MENUS = [
	"/interface detect-internet",
	"/interface l2tp-server server",
	"/interface pptp-server server",
	"/interface sstp-server server",
	"/ip dhcp-client",
	"/ip dhcp-client option",
	"/ip dhcp-server config",
	"/ip firewall service-port",
	"/ip hotspot service-port",
	"/ip ipsec mode-config",
	"/ip nat-pmp",
	"/ip neighbor discovery-settings",
	"/ip traffic-flow",
	"/ip traffic-flow ipfix",
	"/ipv6 dhcp-relay option",
	"/routing igmp-proxy",
	"/system keymat-provider",
	"/system package local-update mirror",
	"/system resource hardware usb-settings",
	"/tool bandwidth-server",
	"/tool e-mail",
	"/tool mac-server",
	"/tool mac-server mac-winbox",
	"/tool mac-server ping",
	"/tool traffic-generator",
];

/**
 * The corpus false positives — the same defect firing on the frozen script
 * corpus, where it was cheap (2.97% of documents) precisely because bare-path
 * navigation into a hyphenated menu is an export idiom, not a scripting one.
 */
const CORPUS_MENUS = [
	"/ip firewall address-list",
	"/ip dhcp-server network",
	"/interface wireless security-profiles",
];

/**
 * Commands the hyphen rule was built to protect, plus one it never caught.
 * `/system reboot` carries no hyphen at all, so the old rule read it as
 * navigation and dropped it — the false negative the table closes.
 * `/ip dhcp-client release` matters most: it is a command inside a menu that IS
 * in the table, so it proves the discrimination is per-path rather than a
 * hyphenated-prefix whitelist.
 *
 * All five are BARE paths, i.e. Q6 refuses to name a verb in them, which is
 * what routes them through `isConfirmedNav` at all. A command whose verb Q6 does
 * decide (`/log print`) never reaches this rule — asserted separately below.
 */
const COMMANDS = [
	"/interface wireless reset-configuration wlan1",
	"/disk format-drive disk1",
	"/system reset-configuration",
	"/system reboot",
	"/ip dhcp-client release",
];

const segmentsOf = (statement: string): string[] =>
	statement
		.replace(/^\//, "")
		.split(/[/\s]+/)
		.filter(Boolean);

describe("explain/menus — the generated table", () => {
	test("carries every menu the export stratum proved", () => {
		const missing = EXPORT_STRATUM_MENUS.filter(
			(m) => !isMenuPath(segmentsOf(m)),
		);
		expect(missing).toEqual([]);
	});

	test("carries the menus the corpus tripped on", () => {
		const missing = CORPUS_MENUS.filter((m) => !isMenuPath(segmentsOf(m)));
		expect(missing).toEqual([]);
	});

	/** The correctness direction: a command listed as a menu would clear a write. */
	test("carries no command", () => {
		const wrong = COMMANDS.filter((c) => isMenuPath(segmentsOf(c)));
		expect(wrong).toEqual([]);
	});

	test("both path spellings and any casing reduce to the same entry", () => {
		expect(isMenuPath(["ip", "address"])).toBe(true);
		expect(isMenuPath(segmentsOf("/ip/address"))).toBe(true);
		expect(isMenuPath(segmentsOf("/IP/Address"))).toBe(true);
	});

	/** An empty run is the bare `/` and `..` forms, decided by their own rule. */
	test("an empty segment list is not a menu", () => {
		expect(isMenuPath([])).toBe(false);
	});

	test("entries are lower-case, slash-led and sorted", () => {
		const entries = [...MENU_PATHS];
		expect(entries.filter((p) => p !== p.toLowerCase())).toEqual([]);
		expect(entries.filter((p) => !p.startsWith("/"))).toEqual([]);
		expect(entries).toEqual([...entries].sort());
	});
});

describe("explain/menus — what write.ts does with it", () => {
	/**
	 * The headline #207 fix. Read through `containsWrite` rather than through
	 * `isMenuPath` so the assertion is about the product behaviour: a menu line
	 * in a document must be dropped as navigation, not reported as a command
	 * with an unrecognized verb.
	 *
	 * A trailing statement keeps `isDanglingBarePath` out of the way — that rule
	 * abstains on ANY bare path at document end, menu or not, so without it these
	 * would all abstain for an unrelated reason.
	 */
	test("a hyphenated menu line is navigation, not an unknown verb", () => {
		for (const menu of [...EXPORT_STRATUM_MENUS, ...CORPUS_MENUS]) {
			const got = containsWrite(`${menu}\n:put 1\n`);
			expect(got.occurrences.map((o) => o.text)).not.toContain(menu);
			expect(got.verdict).toBe("false");
		}
	});

	/** The other direction: none of the protected commands became navigation. */
	test("a bare-path command still emits an occurrence and abstains", () => {
		for (const command of COMMANDS) {
			const got = containsWrite(`${command}\n:put 1\n`);
			expect(got.verdict).toBe("unknown");
			expect(got.blockers.map((b) => b.text)).toContain(command);
		}
	});

	/**
	 * The table is consulted only where Q6 refused to name a verb. A statement
	 * whose verb Q6 DOES decide never reaches it, so `/log print` still reads as
	 * a read verb and clears — the menu table cannot make a decided verb worse.
	 */
	test("a decided verb never reaches the table", () => {
		const got = containsWrite("/log print\n:put 1\n");
		expect(got.verdict).toBe("false");
		expect(got.occurrences.map((o) => o.verb)).toContain("print");
	});

	/**
	 * Fail-closed on absence, which is what licenses shipping a pinned,
	 * deliberately incomplete, version-less table. A menu newer than every pinned
	 * tree must land in the SAME bin as an unrecognized command — abstain — so
	 * version drift costs precision and never correctness.
	 */
	test("a path the table has never seen abstains", () => {
		const unknown = "/interface future-radio not-a-real-menu";
		expect(isMenuPath(segmentsOf(unknown))).toBe(false);
		const got = containsWrite(`${unknown}\n:put 1\n`);
		expect(got.verdict).toBe("unknown");
		expect(got.blockers.map((b) => b.text)).toContain(unknown);
	});

	/**
	 * The export shape end to end: a menu line then a relative write. This is
	 * ~100% of an export's grammar and the reason #203 measured the defect at a
	 * 100% false-positive rate on device output.
	 */
	test("an export fragment resolves to a proven write with no blockers", () => {
		const got = containsWrite(
			"/tool mac-server\nset allowed-interface-list=none\n",
		);
		expect(got.verdict).toBe("true");
		expect(got.blockers).toEqual([]);
	});
});
