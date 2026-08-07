/**
 * One fetch policy for the generators that pull their sources over the network
 * (`gen-explain-menus.ts`, `gen-explain-catalog.ts`).
 *
 * Both run in the QA drift job, where the failure that matters is not a broken
 * source but a *stalled* one: without a timeout a hung connection burns the
 * whole job budget and reports nothing useful. So every request gets a deadline,
 * and a transient failure gets two more tries.
 *
 * A 4xx that is not 429 fails immediately. Retrying it only delays the report,
 * and the answer will not change.
 */

const TIMEOUT_MS = 30_000;
const ATTEMPTS = 3;

export const USER_AGENT = "tikoci-centrs (+https://github.com/tikoci/centrs)";

/** Fetch `url` as text, retrying rate limits and server errors only. */
export async function fetchTextWithRetry(url: string): Promise<string> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		let retryable = true;
		try {
			const response = await fetch(url, {
				headers: { "user-agent": USER_AGENT },
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (response.ok) return await response.text();
			retryable = response.status === 429 || response.status >= 500;
			lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
		} catch (error) {
			lastError = error;
		}
		if (!retryable) break;
		if (attempt < ATTEMPTS) await Bun.sleep(250 * 2 ** (attempt - 1));
	}
	throw new Error(`failed to fetch ${url}`, { cause: lastError });
}
