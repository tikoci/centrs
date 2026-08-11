/** Comparison outcome for one production symbol occurrence against highlight. */
export type SymbolComparison = "agree" | "abstain" | "disagree";

/**
 * Compare one offline answer with the device without turning a deliberate
 * abstention into a false disagreement.
 */
export function compareSymbolClass(
	offline: string | null,
	device: string,
): SymbolComparison {
	if (offline === null) return "abstain";
	return offline === device ? "agree" : "disagree";
}

/** Accept both raw highlight names and the short names older K3 probes wrote. */
export function normalizeVariableClass(value: string): string {
	return value.replace(/^variable-/, "");
}
