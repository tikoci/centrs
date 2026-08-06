/**
 * In-process CLI capture: run `runCli` with `console.log`/`console.error`
 * swapped for buffers, and restore them afterwards.
 *
 * Shared because two suites need the identical harness (`cli-errors.test.ts`
 * asserts the typed-error shape across runners, `explain.test.ts` asserts the
 * offline examples), and a second copy of the swap/restore dance is a second
 * place for a leaked `console` override to hide.
 *
 * This is the *in-process* tier. Anything that depends on real stdio — bytes on
 * fd 0, raw stdout writes, a process exit code — belongs in the subprocess
 * harness instead (`test/integration/cli-process.ts`).
 */

import { afterEach } from "bun:test";
import { runCli } from "../../src/cli.ts";

export interface CapturedCli {
	code: number;
	out: string;
	err: string;
}

const restorers: Array<() => void> = [];

afterEach(() => {
	while (restorers.length > 0) restorers.pop()?.();
});

export async function runCliCaptured(
	args: readonly string[],
): Promise<CapturedCli> {
	const logs: string[] = [];
	const errs: string[] = [];
	const origLog = console.log;
	const origErr = console.error;
	console.log = (...a: unknown[]) => {
		logs.push(a.map(String).join(" "));
	};
	console.error = (...a: unknown[]) => {
		errs.push(a.map(String).join(" "));
	};
	restorers.push(() => {
		console.log = origLog;
		console.error = origErr;
	});
	const code = await runCli(args);
	return { code, out: logs.join("\n"), err: errs.join("\n") };
}
