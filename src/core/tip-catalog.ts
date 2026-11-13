/**
 * The centrs tip-code catalog: every `tip/*` code the codebase can emit.
 *
 * A tip is self-contained advice, so most tips have no page. A tip carries a
 * `detailsUrl` only when `page` is true, and then `docs/tips/<slug>.md` must
 * exist (`test/unit/tip-catalog.test.ts`). The page contract, including when a
 * tip earns a page, is in `docs/errors/README.md` (#659).
 *
 * Summaries are canonical one-liners for the tip class, not the interpolated
 * message a call site builds.
 */

export interface TipCatalogEntry {
	code: `tip/${string}`;
	summary: string;
	/** True when `docs/tips/<slug>.md` exists and the tip links to it. */
	page: boolean;
}

export const tipCatalog = [
	{
		code: "tip/comment-kv-may-override",
		summary:
			"A device's own comment-kv key takes precedence over a global setting.",
		page: false,
	},
	{
		code: "tip/credentials-missing",
		summary:
			"The saved device has no stored password and no __default__ record to fall back on.",
		page: true,
	},
	{
		code: "tip/discover-save",
		summary: "discover found neighbors but did not save them without --save.",
		page: false,
	},
	{
		code: "tip/execute-bare-menu-path",
		summary: "A bare menu path navigates or is refused; it returns no rows.",
		page: false,
	},
	{
		code: "tip/explain-live-facets",
		summary: "Schema and completion facets need a router to ask.",
		page: false,
	},
	{
		code: "tip/explain-offline-only",
		summary: "With no router, explain gives the canonicalizer's reading alone.",
		page: false,
	},
	{
		code: "tip/explain-pasted-prompt",
		summary:
			"The input looks like a pasted console prompt or transcript, not a command.",
		page: false,
	},
	{
		code: "tip/explain-schema-truncated",
		summary:
			"A described schema was cut to the size ceiling; counts are whole.",
		page: false,
	},
	{
		code: "tip/filtered-follow",
		summary:
			"A filtered change feed reports neither rows that leave the filter nor deletes.",
		page: false,
	},
	{
		code: "tip/follow-proplist",
		summary: "A --proplist without .id/.dead hides deletes in a change feed.",
		page: false,
	},
	{
		code: "tip/follow-sweep-off",
		summary: "--sweep 0 stops reporting removals RouterOS does not send.",
		page: false,
	},
	{
		code: "tip/mac-telnet-no-credentials",
		summary: "No username or password was resolved for a MAC-Telnet target.",
		page: false,
	},
	{
		code: "tip/no-devices",
		summary: "The CDB has no device records yet.",
		page: true,
	},
	{
		code: "tip/rest-verb-mapping",
		summary: "REST creates with PUT, not POST, on a menu path.",
		page: false,
	},
	{
		code: "tip/select-target",
		summary: "No <router> was given; these saved devices can be named.",
		page: false,
	},
	{
		code: "tip/sftp-password-not-used",
		summary: "Batch SFTP uses SSH keys only; a resolved password is not sent.",
		page: false,
	},
	{
		code: "tip/stream-print",
		summary: "api --stream on a print streams one print; it does not follow.",
		page: false,
	},
	{
		code: "tip/transfer-password-transport",
		summary: "REST and the native API transfer with the username and password.",
		page: false,
	},
] as const satisfies readonly TipCatalogEntry[];

export type TipCode = (typeof tipCatalog)[number]["code"];

const tipsWithPages: ReadonlySet<string> = new Set(
	tipCatalog.filter((entry) => entry.page).map((entry) => entry.code),
);

/** Base URL for tip pages. A tip's page is `<base><slug>/`, without `tip/`. */
export const TIPS_BASE_URL = "https://tikoci.dev/centrs/tips/";

/**
 * The page URL for a tip code, or undefined when the tip has no page.
 * `pages` defaults to the catalog's `page: true` entries; tests pass their own
 * set to cover the URL shape while no tip has a page.
 */
export function tipDetailsUrl(
	code: TipCode,
	pages: ReadonlySet<string> = tipsWithPages,
): string | undefined {
	return pages.has(code)
		? `${TIPS_BASE_URL}${code.slice("tip/".length)}/`
		: undefined;
}
