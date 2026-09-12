/**
 * Envelope YAML rendering — the `--format yaml` writer shared by every command.
 *
 * This is a **renderer, not a YAML library**: it serializes the envelope shapes
 * centrs builds (scalars, arrays, plain objects) and quotes every string through
 * `JSON.stringify`, which is valid YAML double-quoted scalar syntax. It does not
 * parse YAML, emit anchors/aliases, or handle cycles.
 *
 * It lives in `src/core/` because it is **pure** — no Bun, filesystem, network,
 * or CDB reach. `retrieve.ts` used to own it, which put every consumer of
 * `toYaml` one import away from the transport stack; `explain`'s offline entry
 * runs in a browser only because this function no longer drags that graph
 * behind it (#312). Every importer now takes `toYaml` from here; `retrieve.ts`
 * is one of them, and the function itself moved character for character.
 */

/**
 * Render `value` as YAML at `indent` spaces of nesting.
 *
 * `undefined` object entries are dropped (they have no YAML spelling and the
 * envelope uses them for absent-optional); `undefined` in scalar position and
 * `null` both render `null`. A non-plain object that is neither array nor
 * scalar falls back to its JSON text as a quoted scalar rather than guessing.
 */
export function toYaml(value: unknown, indent = 0): string {
	const prefix = " ".repeat(indent);
	if (value === null || value === undefined) {
		return "null";
	}
	if (typeof value === "string") {
		return yamlScalar(value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return `${prefix}[]`;
		}
		return value
			.map((item) => {
				if (isScalar(item)) {
					return `${prefix}- ${toYaml(item, indent + 2)}`;
				}
				return `${prefix}-\n${toYaml(item, indent + 2)}`;
			})
			.join("\n");
	}
	if (isPlainObject(value)) {
		const entries = Object.entries(value).filter(
			([, entryValue]) => entryValue !== undefined,
		);
		if (entries.length === 0) {
			return `${prefix}{}`;
		}
		return entries
			.map(([key, entryValue]) => {
				if (isScalar(entryValue)) {
					return `${prefix}${key}: ${toYaml(entryValue, indent + 2)}`;
				}
				return `${prefix}${key}:\n${toYaml(entryValue, indent + 2)}`;
			})
			.join("\n");
	}
	return yamlScalar(JSON.stringify(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is boolean | number | string | null {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

function yamlScalar(value: string): string {
	if (value.length === 0) {
		return '""';
	}
	return JSON.stringify(value);
}
