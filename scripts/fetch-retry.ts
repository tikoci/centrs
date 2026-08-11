/**
 * One fetch policy for the scripts that pull their sources over the network
 * (`gen-explain-menus.ts`, `gen-explain-catalog.ts`, `corpus-fetch.ts`).
 *
 * The first two run in the QA drift job, where the failure that matters is not
 * a broken source but a *stalled* one: without a timeout a hung connection
 * burns the whole job budget and reports nothing useful. So every request gets
 * a deadline, and a transient failure gets two more tries.
 *
 * What retries: a thrown request error (connection reset, DNS, the deadline
 * itself), a 429, and any 5xx. What does not: every other 4xx — retrying it
 * only delays the report, and the answer will not change.
 *
 * The deadline covers the body read, not just the response head — a truncated
 * download is exactly the failure a byte-count check would otherwise catch late.
 */

const TIMEOUT_MS = 30_000;
const ATTEMPTS = 3;

export const USER_AGENT = "tikoci-centrs (+https://github.com/tikoci/centrs)";

async function fetchWithRetry<T>(
	url: string,
	read: (response: Response) => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		let retryable = true;
		try {
			const response = await fetch(url, {
				headers: { "user-agent": USER_AGENT },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (response.ok) return await read(response);
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

/** Fetch `url` as text under the policy above. */
export async function fetchTextWithRetry(url: string): Promise<string> {
	return await fetchWithRetry(url, (response) => response.text(), TIMEOUT_MS);
}

/**
 * Fetch `url` as bytes. Same retry policy; the deadline is a parameter because
 * a 10 MB binary over a cold CI link is not a 30-second job the way a JSON
 * catalog is.
 */
export async function fetchBytesWithRetry(
	url: string,
	timeoutMs: number = TIMEOUT_MS,
): Promise<Uint8Array> {
	return await fetchWithRetry(url, (response) => response.bytes(), timeoutMs);
}
