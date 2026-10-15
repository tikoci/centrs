/**
 * #453: name the fleet a CMR controller command reaches, before its write gate.
 *
 * A controller command such as `/cmr/device/reboot labels=all` is one request
 * to one router, but it acts on every device its `labels`/`numbers` select,
 * the controller's own row included. This module recognizes those commands,
 * reads the controller's `/cmr/device` inventory (read-only), and resolves the
 * selection host-side so the gate can say "N devices, the controller
 * included" and warn on the manual's no-selector hazards. The command itself
 * still runs exactly as typed; nothing here rewrites it.
 *
 * Grounded on a 7.26beta1 two-CHR lab (2026-10-15):
 *
 *   - The controller's own row carries `controller=true`.
 *   - The manual's label rules evaluated over a row's `labels` ∪ `auto-labels`
 *     matched the device's own selection (a `run-script numbers=<id>
 *     labels=<expr>` probe per row) in every expression tried: `all`, `-x`,
 *     an identity, an architecture, an unknown label, `a,+b`, `a,-b`,
 *     `all,-a`, and a case change (labels are case-sensitive).
 *   - A row's `auto-labels` can be stale while the device is disconnected, so
 *     the result is the controller's current view, which the wording says.
 *   - Each row names its `upgrade-rule`, so `/cmr/upgrade/trigger` resolves
 *     exactly. `/cmr/upgrade/show-devices` is not reachable over REST (404).
 *   - A `/cmr/vlan` or `/cmr/wifi` item added without `labels` stores none.
 *     Per the manual, such a VLAN rule (no `port-labels` either) provisions
 *     every port of every connected device, the controller included, and an
 *     upgrade rule without labels covers every device.
 *
 * Not resolved, so the gate keeps its plain wording: script-shaped input (a
 * positional or `[find …]` selector), an abbreviated selector argument, a
 * console transport (no structured read), `/cmr/upgrade/job/run-next` (the
 * job's device list is not in the inventory), and a failed read.
 */

import type { ProtocolAdapter } from "../protocols/adapter.ts";
import {
	CMR_SCRIPT_POLICIES,
	type CmrCallerPolicy,
	cmrCallerPolicyWarning,
	readCmrCallerPolicy,
} from "./cmr.ts";
import type { Warning } from "./envelope.ts";

type FleetKind = "device" | "rule" | "trigger" | "job";

interface FleetEntry {
	menu: readonly string[];
	verbs: readonly string[];
	kind: FleetKind;
}

const RULE_VERBS = ["add", "set", "remove", "enable", "disable"] as const;

/** Controller commands that act on the devices their selection names. */
const FLEET_COMMANDS: readonly FleetEntry[] = [
	{
		menu: ["cmr", "device"],
		verbs: ["reboot", "upgrade", "pair", "run-script"],
		kind: "device",
	},
	{ menu: ["cmr", "upgrade"], verbs: ["trigger"], kind: "trigger" },
	{ menu: ["cmr", "upgrade", "job"], verbs: ["run-next"], kind: "job" },
	{ menu: ["cmr", "upgrade"], verbs: RULE_VERBS, kind: "rule" },
	{ menu: ["cmr", "vlan"], verbs: RULE_VERBS, kind: "rule" },
	{ menu: ["cmr", "wifi"], verbs: RULE_VERBS, kind: "rule" },
	{ menu: ["cmr", "wifi", "radio"], verbs: RULE_VERBS, kind: "rule" },
];

/**
 * The policies a fleet command runs with on the clients, where #456 measured
 * that RouterOS does not check them against the controller login (7.26beta1):
 * `run-script` needs only `read` + `api`, `reboot` only `read` + `test` +
 * `api`. Other fleet commands were not measured, so they carry no warning.
 */
const RUNS_WITH: Readonly<Record<string, readonly string[]>> = {
	"/cmr/device/run-script": CMR_SCRIPT_POLICIES,
	"/cmr/device/reboot": ["reboot"],
};

/** WiFi band labels select radios, not devices (manual: `+2ghz`, `+5ghz`, `+6ghz`). */
const BAND_LABEL = /^\+[256]ghz$/;

const SELECTOR_ARGUMENTS = ["labels", "port-labels", "numbers", "number"];

/** A recognized fleet command, before anything is read. */
export interface CmrFleetCommand {
	/** Full spelling, e.g. `/cmr/device/reboot` (abbreviations expanded). */
	command: string;
	menu: string;
	verb: string;
	kind: FleetKind;
	attributes: Readonly<Record<string, string>>;
}

/** One `/cmr/device` row the selection reaches. */
export interface CmrFleetDevice {
	id: string;
	identity: string;
	controller: boolean;
	connected: boolean;
}

/** What the gate says about a fleet command. */
export interface CmrFleetScope {
	command: string;
	/** The devices reached, by the controller's current inventory; absent when not resolved. */
	devices?: CmrFleetDevice[];
	/** Size of the controller's `/cmr/device` inventory. */
	inventory?: number;
	/** Why `devices` is absent. */
	unresolved?: string;
	/** A rule without a device selector (applies to every device). */
	everyDevice?: boolean;
}

/**
 * Recognize a fleet command from a structured path (`/cmr/device/reboot`,
 * each segment possibly abbreviated as RouterOS accepts) and its attributes.
 */
export function cmrFleetCommand(
	path: string,
	attributes: Readonly<Record<string, string>>,
): CmrFleetCommand | undefined {
	const segments = path
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => segment.toLowerCase());
	for (const entry of FLEET_COMMANDS) {
		if (segments.length !== entry.menu.length + 1) continue;
		const menuMatches = entry.menu.every((name, k) =>
			name.startsWith(segments[k] as string),
		);
		if (!menuMatches) continue;
		const typed = segments.at(-1) as string;
		const verbs = entry.verbs.filter((verb) => verb.startsWith(typed));
		const verb = verbs.includes(typed) ? typed : verbs[0];
		if (verb === undefined || (verbs.length > 1 && !verbs.includes(typed))) {
			continue;
		}
		const menu = `/${entry.menu.join("/")}`;
		return {
			command: `${menu}/${verb}`,
			menu,
			verb,
			kind: entry.kind,
			attributes,
		};
	}
	return undefined;
}

/**
 * Whether a comma-separated CMR `labels` expression selects a device with
 * these labels. Plain labels OR together, `+label` must also match, `-label`
 * excludes, `all` matches every device, and an expression with no plain label
 * starts from every device (`-core` = `all,-core`). Case-sensitive.
 */
export function cmrLabelsSelect(
	expression: string,
	labels: ReadonlySet<string>,
): boolean {
	let plain = false;
	let matched = false;
	for (const raw of expression.split(",")) {
		const item = raw.trim();
		if (item.length === 0) continue;
		if (item.startsWith("+")) {
			if (!labels.has(item.slice(1))) return false;
		} else if (item.startsWith("-")) {
			if (labels.has(item.slice(1))) return false;
		} else {
			plain = true;
			if (item === "all" || labels.has(item)) matched = true;
		}
	}
	return plain ? matched : true;
}

type Row = Record<string, string>;

function labelSet(row: Row): Set<string> {
	return new Set(
		`${row["labels"] ?? ""},${row["auto-labels"] ?? ""}`
			.split(",")
			.map((label) => label.trim())
			.filter((label) => label.length > 0),
	);
}

function toDevice(row: Row): CmrFleetDevice {
	return {
		id: row[".id"] ?? "",
		identity: row["identity"] ?? "",
		controller: row["controller"] === "true",
		connected: row["connected"] === "true",
	};
}

function listItems(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/** A `numbers=` item names a row by `.id` (any case) or by its `name`/`identity`. */
function rowNamed(row: Row, item: string, nameField: string): boolean {
	return (
		row[".id"]?.toLowerCase() === item.toLowerCase() || row[nameField] === item
	);
}

/** Drop band labels from a WiFi expression; they pick radios, not devices. */
function deviceLabels(command: CmrFleetCommand, labels: string): string {
	if (!command.menu.startsWith("/cmr/wifi")) return labels;
	return listItems(labels)
		.filter((item) => !BAND_LABEL.test(item))
		.join(",");
}

function abbreviatedSelector(
	attributes: Readonly<Record<string, string>>,
): string | undefined {
	return Object.keys(attributes).find(
		(key) =>
			!SELECTOR_ARGUMENTS.includes(key) &&
			SELECTOR_ARGUMENTS.some((name) => name.startsWith(key)),
	);
}

/**
 * Resolve which inventory rows a fleet command reaches. `read` returns a
 * menu's rows (`/cmr/device`, or the rule's own menu for `set`/`remove`).
 */
export async function resolveCmrFleetScope(
	command: CmrFleetCommand,
	read: (menu: string) => Promise<Row[]>,
): Promise<CmrFleetScope> {
	const scope = (fields: Omit<CmrFleetScope, "command">): CmrFleetScope => ({
		command: command.command,
		...fields,
	});
	const abbreviated = abbreviatedSelector(command.attributes);
	if (abbreviated !== undefined) {
		return scope({
			unresolved: `the abbreviated argument \`${abbreviated}=\` was not expanded`,
		});
	}
	if (command.kind === "job") {
		return scope({
			unresolved: "an upgrade job's devices are not in the inventory",
		});
	}
	const rows = await read("/cmr/device");
	const inventory = rows.length;
	const select = (labels: string | undefined, numbers?: string) => {
		const ids = numbers === undefined ? undefined : listItems(numbers);
		return rows
			.filter(
				(row) =>
					(ids === undefined ||
						ids.some((item) => rowNamed(row, item, "identity"))) &&
					(labels === undefined || cmrLabelsSelect(labels, labelSet(row))),
			)
			.map(toDevice);
	};
	const { attributes } = command;

	if (command.kind === "device") {
		const labels = attributes["labels"]?.trim() || undefined;
		const numbers = attributes["numbers"]?.trim() || undefined;
		if (labels === undefined && numbers === undefined) {
			return scope({ inventory, unresolved: "no `numbers` or `labels`" });
		}
		return scope({ inventory, devices: select(labels, numbers) });
	}

	if (command.kind === "trigger") {
		const numbers = attributes["numbers"]?.trim();
		if (!numbers) return scope({ inventory, unresolved: "no `numbers`" });
		const rules = await read("/cmr/upgrade");
		const names = new Set(
			listItems(numbers).flatMap((item) =>
				rules
					.filter((rule) => rowNamed(rule, item, "name"))
					.map((rule) => rule["name"] ?? ""),
			),
		);
		return scope({
			inventory,
			devices: rows
				.filter((row) => names.has(row["upgrade-rule"] ?? ""))
				.map(toDevice),
		});
	}

	// A rule: `add` uses its own selectors; the others act on existing items,
	// and a `set` that changes a selector reaches the old and the new state.
	// Each state is judged on its own: one unscoped rule among several still
	// reaches every device.
	const states: { labels?: string; portLabels?: string }[] = [];
	if (command.verb === "add") {
		states.push({
			labels: attributes["labels"],
			portLabels: attributes["port-labels"],
		});
	} else {
		const numbers = attributes["numbers"]?.trim();
		if (!numbers) return scope({ inventory, unresolved: "no `numbers`" });
		const items = await read(command.menu);
		const named = listItems(numbers).map((item) =>
			items.find((rule) => rowNamed(rule, item, "name")),
		);
		if (named.some((rule) => rule === undefined)) {
			return scope({
				inventory,
				unresolved: `\`numbers=${numbers}\` did not match a ${command.menu} item`,
			});
		}
		for (const rule of named as Row[]) {
			const old = { labels: rule["labels"], portLabels: rule["port-labels"] };
			states.push(old);
			if (
				command.verb === "set" &&
				("labels" in attributes || "port-labels" in attributes)
			) {
				states.push({
					labels: attributes["labels"] ?? old.labels,
					portLabels: attributes["port-labels"] ?? old.portLabels,
				});
			}
		}
	}
	const reached = new Map<string, CmrFleetDevice>();
	let everyDevice = false;
	for (const state of states) {
		const labels = deviceLabels(command, state.labels?.trim() ?? "");
		// VLAN: no `labels` but `port-labels` still narrows which ports change.
		const narrowedByPort =
			command.menu === "/cmr/vlan" && (state.portLabels?.trim() ?? "") !== "";
		if (labels.length === 0 && !narrowedByPort) everyDevice = true;
		for (const device of select(labels || "all")) {
			reached.set(device.id, device);
		}
	}
	return scope({ inventory, devices: [...reached.values()], everyDevice });
}

/**
 * The gate's phrase for a scope, e.g. `2 CMR device(s) through controller
 * ctl, the controller itself among them`.
 */
function describeReach(scope: CmrFleetScope, controller: string): string {
	if (scope.devices === undefined) {
		return `the CMR devices it selects through controller ${controller} (not resolved: ${scope.unresolved})`;
	}
	const self = scope.devices.some((device) => device.controller);
	return `${scope.devices.length} CMR device(s) through controller ${controller}${self ? ", the controller itself among them" : ""}`;
}

/** Warnings for a resolved scope: the controller in it, every device, nothing. */
export function cmrFleetWarnings(scope: CmrFleetScope): Warning[] {
	const warnings: Warning[] = [];
	if (scope.everyDevice) {
		const subject = scope.command.endsWith("/add")
			? `\`${scope.command}\` adds a rule`
			: `\`${scope.command}\` acts on a rule`;
		warnings.push({
			code: "cmr/rule-selects-every-device",
			message: scope.command.startsWith("/cmr/vlan/")
				? `${subject} with no \`labels\` and no \`port-labels\`: it provisions every port of every connected device, the controller included, which cuts the fleet's management access.`
				: `${subject} with no device \`labels\`: it applies to every device the controller manages, the controller included.`,
			context: { command: scope.command, inventory: scope.inventory },
		});
	}
	if (scope.devices === undefined) return warnings;
	const controller = scope.devices.find((device) => device.controller);
	if (controller && !scope.everyDevice) {
		warnings.push({
			code: "cmr/selection-includes-controller",
			message: `\`${scope.command}\` selects the controller's own row (\`${controller.identity}\`) as well as ${scope.devices.length - 1} other device(s).`,
			context: {
				command: scope.command,
				controller: controller.identity,
				devices: scope.devices.length,
			},
		});
	}
	if (scope.devices.length === 0) {
		warnings.push({
			code: "cmr/empty-selection",
			message: `\`${scope.command}\` selects no device in the controller's inventory now. Labels are case-sensitive and RouterOS accepts unknown ones silently.`,
			context: { command: scope.command, inventory: scope.inventory },
		});
	}
	return warnings;
}

/** The gate's error context for a fleet scope. */
export function cmrFleetContext(scope: CmrFleetScope): Record<string, unknown> {
	return {
		command: scope.command,
		...(scope.devices === undefined
			? { unresolved: scope.unresolved }
			: {
					devices: scope.devices.length,
					connected: scope.devices.filter((device) => device.connected).length,
					controllerIncluded: scope.devices.some((device) => device.controller),
					identities: scope.devices.map((device) => device.identity),
				}),
		...(scope.inventory === undefined ? {} : { inventory: scope.inventory }),
	};
}

/** Result of {@link readCmrFleet}: the scope and the warnings it raises. */
export interface CmrFleetRead {
	scope: CmrFleetScope;
	warnings: Warning[];
}

/**
 * The write gate's wording for a fleet command: the TTY prompt and the
 * refusal summary name the reach and repeat each warning, since a person
 * answering the prompt never sees the envelope's `warnings`.
 */
export function cmrFleetGate(
	fleet: CmrFleetRead,
	controller: string,
): { prompt: string; summary: string; context: Record<string, unknown> } {
	const reach = describeReach(fleet.scope, controller);
	const notes = fleet.warnings
		.filter((warning) => warning.code !== "cmr/selection-includes-controller")
		.map((warning) => ` ${warning.message}`)
		.join("");
	return {
		prompt: `Run write-shaped \`${fleet.scope.command}\` on ${reach}?${notes} Type yes to continue: `,
		summary: `A write-shaped \`${fleet.scope.command}\` would reach ${reach}, and needs explicit confirmation.${notes}`,
		context: { cmr: cmrFleetContext(fleet.scope) },
	};
}

/** Whether an adapter for this transport can do the structured scope read. */
export function cmrFleetReadable(via: string): boolean {
	return via === "native-api" || via === "rest-api";
}

/**
 * Read a fleet command's scope (and, for `run-script`/`reboot`, the caller's
 * policy) on the controller. Best effort: a failed read leaves the scope
 * unresolved and the gate as strict as before.
 */
export async function readCmrFleet(
	command: CmrFleetCommand,
	adapter: Pick<ProtocolAdapter, "apiRequest">,
	username: string | undefined,
): Promise<CmrFleetRead> {
	const read = async (menu: string) => {
		const result = await adapter.apiRequest({ verb: "print", path: menu });
		return Array.isArray(result.data) ? (result.data as Row[]) : [];
	};
	let scope: CmrFleetScope;
	let unreachable = false;
	try {
		scope = await resolveCmrFleetScope(command, read);
	} catch (error) {
		const code =
			error instanceof Error && "code" in error ? String(error.code) : "error";
		// The policy read would wait out the same dead controller (or login).
		unreachable = code.startsWith("transport/") || code.startsWith("auth/");
		scope = {
			command: command.command,
			unresolved: `the controller read failed (${code})`,
		};
	}
	const warnings = cmrFleetWarnings(scope);
	const runsWith = RUNS_WITH[command.command];
	if (runsWith !== undefined && username && !unreachable) {
		const caller: CmrCallerPolicy | undefined = await readCmrCallerPolicy(
			adapter,
			username,
		);
		const warning = caller && cmrCallerPolicyWarning(caller, runsWith);
		if (warning) warnings.push(warning);
	}
	return { scope, warnings };
}
