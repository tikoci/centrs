/**
 * Which root-directive value slots read a `{…}` as an ARRAY (#225, #257).
 *
 * `explain` used to gate brace arrays on the statement's resolved path: any
 * `/` path allowed one, positionally or under `in=`. A device sweep showed that
 * is wrong in both directions on CHR 7.23.3 — `:delay {1;2}`, `:beep {1;2}`,
 * `:resolve {1;2}`, `:if condition={1;2}` and `:local name={1;2}` are syntax
 * errors the path rule called arrays, while `:for from=`, `:execute script=`,
 * `:local value=` and 50-odd more are accepted braces it refused.
 *
 * The real key is the SLOT, and a slot has four outcomes, not two:
 *
 *   - **array** — the content is EVALUATED: `:foreach i in={(1,2)} do={}`
 *     lowers to `in=(, 1 2)`. Only these 72 belong here.
 *   - **code** — the braces are a program. `:onerror e in={1;2} do={}` lowers
 *     to `in=;(evl (<%% bad command name 1 …))`, so the SAME NAME is an array
 *     on `:foreach` and a block on `:onerror`.
 *   - **text** — the brace is accepted and its content taken VERBATIM as a
 *     script: `:execute script={(1,2)}` lowers to `script=(1,2)`, not
 *     `(, 1 2)`. This outcome is why `{1;2}` alone is not a sufficient probe —
 *     `:local z {1;2}` and `:execute script={1;2}` both lower to `…=1;2`, and
 *     reading only that put `:execute script=` in the array set, one step from
 *     hinting `array` on a script body.
 *   - **error** — `:parse` refuses the statement.
 *
 * A slot the sweep could not ask (30 of 222, mostly ones whose scalar control
 * also fails) is absent from this table, which is the fail-closed direction:
 * absent means the walk refuses to read the value, and a refusal costs nothing
 * but coverage. Every brace array in the 948-script corpus lands on a slot
 * listed here except one `:execute {…}` script body, which is `text`.
 *
 * A positional slot is keyed by its zero-based index among positionals, because
 * position decides: `:local {1;2}` puts the literal in the NAME slot (a syntax
 * error) while `:local z {1;2}` puts it in the VALUE slot.
 *
 * **The verb is matched VERBATIM, and that is the device's rule, not laziness.**
 * `verbsplit.ts` keeps a run token's source casing, and RouterOS accepts only
 * the lower-case spelling: `:LOCAL z {1;2}`, `:Local z {1;2}`, `:PUT {1;2}` and
 * even `/IP/DNS/set servers=1.1.1.1` all draw `expected command name (line 1
 * column 2)` on CHR 7.23.3, while an ARGUMENT's casing is free (`:local Z {1;2}`
 * parses and binds `$Z`). Normalizing the verb here would open the gate on a
 * statement the device refuses to parse — the exact fabrication this table
 * exists to remove — so a differently-cased directive misses every entry and is
 * refused, which is the same answer the device gives.
 *
 * The evidence is `test/fixtures/explain/values.json` →
 * `interiorGrounding.braceSlots` (222 rows, CHR 7.23.3, `:parse` IL — NOT
 * `highlight`, which accepts `{1;2,}` and `(1,)` that `:parse` rejects), and
 * `explain-values.test.ts` asserts this table still equals the `array` rows of
 * that block. Re-derive with `.scratch/explain-225-brace-slot-sweep.ts`.
 */
const BRACE_ARRAY_SLOTS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
	(
		[
			[
				"convert",
				["#0", "from-scheme", "to-scheme", "transform-scheme", "value"],
			],
			["deserialize", ["#0", "value"]],
			["error", ["#0", "message"]],
			["find", ["#0", "#1", "from", "in", "key"]],
			["for", ["from", "step", "to"]],
			["foreach", ["in"]],
			["global", ["#1", "value"]],
			["len", ["#0", "value"]],
			["local", ["#1", "value"]],
			["parse", ["#0", "value"]],
			["pick", ["#0", "#1", "begin", "counter", "end"]],
			["put", ["#0", "message"]],
			["range", ["#0", "#1", "from", "to"]],
			["return", ["#0", "value"]],
			["rndnum", ["#0", "#1", "from", "to"]],
			["rndstr", ["#0", "#1", "from", "length"]],
			["serialize", ["#0", "order", "value"]],
			["set", ["#1", "value"]],
			["toarray", ["#0", "value"]],
			["tobool", ["#0", "value"]],
			["toid", ["#0", "value"]],
			["toip", ["#0", "value"]],
			["toip6", ["#0", "value"]],
			["tonsec", ["#0", "value"]],
			["tonum", ["#0", "value"]],
			["tostr", ["#0", "value"]],
			["totime", ["#0", "value"]],
			["typeof", ["#0", "value"]],
		] as const
	).map(([verb, slots]) => [verb, new Set<string>(slots)]),
);

/** The table as flat `verb slot` pairs, for the fixture-drift assertion. */
export function braceArraySlotPairs(): string[] {
	const pairs: string[] = [];
	for (const [verb, slots] of BRACE_ARRAY_SLOTS)
		for (const slot of slots) pairs.push(`${verb} ${slot}`);
	return pairs.sort();
}

/**
 * Whether a `{…}` in this slot of this root directive is an array literal.
 *
 * `verb` is the resolved directive name without its colon; `slot` is the
 * lowercase argument name, or `#<index>` for a positional.
 */
export function braceSlotTakesArray(verb: string, slot: string): boolean {
	return BRACE_ARRAY_SLOTS.get(verb)?.has(slot) === true;
}
