import { lookupPath } from "./catalog.ts";
import { isMenuPath } from "./menus.ts";

/**
 * Whether `segments` name a known RouterOS menu or settings path.
 *
 * Union of the two shipped structure tables (#235): `MENU_PATHS` (#207,
 * `isMenuPath`) and `PATH_CATALOG` menu/settings rows (#228, `lookupPath`).
 * Presence is load-bearing, absence abstains — the caller must not read
 * absence as evidence of a command.
 */
export function isKnownMenuPath(segments: readonly string[]): boolean {
	const entry = lookupPath(segments);
	return (
		isMenuPath(segments) || entry?.kind === "menu" || entry?.kind === "settings"
	);
}
