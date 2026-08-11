/**
 * Minimal CHR handle for the promoted `explain` device probes (#186).
 *
 * `@tikoci/quickchr` is an OPTIONAL dependency and ships TypeScript sources, not
 * declarations, so a static `import { QuickCHR } from "@tikoci/quickchr"` drags
 * its whole `src/` tree into `tsc --noEmit` and fails the repo's strict flags
 * (82 errors, none of them ours). `test/integration/chr.ts` already solved this
 * by importing through a variable specifier and declaring the surface it uses
 * locally; this is the same trick for the `scripts/probes/` side, kept separate
 * because a probe wants raw `QuickCHR.start`/`.get`, not the integration
 * harness's evidence recording.
 *
 * The declared surface is deliberately the subset the probes call. Widen it when
 * a probe needs more, rather than reaching for `any`.
 */

/** The subset of quickchr's instance surface the probes use. */
export interface ProbeChr {
	name: string;
	/** Run a RouterOS console command. */
	exec(command: string): Promise<unknown>;
	/** Issue a REST request; GET is the default when no init is supplied. */
	rest(path: string, init?: RequestInit): Promise<unknown>;
	/** Stop and delete the machine. */
	remove(): Promise<void>;
}

interface ProbeStartOptions {
	name?: string;
	version?: string;
	arch?: "arm64" | "x86";
}

interface QuickChrModule {
	QuickCHR: {
		start(options: ProbeStartOptions): Promise<ProbeChr>;
		get(name: string): Promise<ProbeChr | null>;
	};
}

/**
 * Attach to an existing CHR by name, or boot a fresh one.
 *
 * Every probe here takes an optional machine name as `argv[2]`: passing one
 * REUSES that machine and leaves it running, which is how a sweep is re-run
 * against the same device without paying the boot cost. Omitting it boots a
 * throwaway the caller is expected to `remove()`.
 */
export async function openChr(options: {
	reuse: string | undefined;
	name: string;
	version?: string;
}): Promise<ProbeChr> {
	const moduleName = "@tikoci/quickchr";
	let QuickCHR: QuickChrModule["QuickCHR"];
	try {
		({ QuickCHR } = (await import(moduleName)) as unknown as QuickChrModule);
	} catch (error) {
		// quickchr is an OPTIONAL dependency, so a probe run on a clone that
		// skipped optionals fails with a bare module-resolution error that says
		// nothing about what to do. These scripts are meant for contributors.
		throw new Error(
			"`@tikoci/quickchr` is not installed. It is an optional dependency; " +
				"install it with `bun install` (without --omit=optional) to run the " +
				`device probes in scripts/probes/. Original error: ${
					error instanceof Error ? error.message : String(error)
				}`,
		);
	}
	if (options.reuse) {
		const existing = await QuickCHR.get(options.reuse);
		if (!existing) throw new Error(`no CHR named ${options.reuse}`);
		return existing;
	}
	return await QuickCHR.start({
		name: `${options.name}-${Date.now()}`,
		...(options.version ? { version: options.version } : {}),
		arch: "x86",
	});
}

/**
 * Where a probe writes its capture.
 *
 * `.scratch/` on purpose: a probe RUN is in-flight work, and only the reviewed
 * slice of it that lands under `test/fixtures/` is durable. The directory is
 * gitignored and may not exist in a fresh clone, so create it.
 */
export async function probeOutputPath(fileName: string): Promise<string> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(".scratch", { recursive: true });
	return `.scratch/${fileName}`;
}
