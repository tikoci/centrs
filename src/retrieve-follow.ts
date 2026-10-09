/**
 * `retrieve --follow`: keep a menu's rows current over native-api `listen`.
 * The contract (line kinds, A1 bootstrap, `.id` sweep, bounds) is
 * `commands/retrieve/README.md` → Follow; the CHR evidence is #396.
 *
 * One native connection carries the `listen` (started first), snapshot,
 * membership reads and periodic sweep. Replies land in one arrival-ordered
 * queue. Filtered membership adds per-id wire versions so delayed replies
 * cannot overwrite newer changes; membership reads and sweeps are serialized.
 */

import {
	buildTip,
	type EnvelopeValidationMeta,
	type Tip,
	type Warning,
} from "./core/envelope.ts";
import { inspectArgumentNames, pathTokens } from "./core/inspect.ts";
import { CentrsError } from "./errors.ts";
import {
	createProtocolAdapter,
	type ProtocolAdapter,
	type ProtocolApiRequest,
	type ProtocolListenOptions,
	type ProtocolTappedReply,
} from "./protocols/adapter.ts";
import {
	buildRetrieveErrorEnvelope,
	buildRetrieveErrorEnvelopeFromResolved,
	type ResolvedRetrieveRequest,
	type RetrieveEnvelope,
	type RetrieveFollowCounts,
	type RetrieveFollowStopReason,
	type RetrieveFollowSummary,
	type RetrieveRequest,
	type RetrieveStreamMeta,
	type RetrieveSuccessEnvelope,
	resolveRetrieveRequest,
	validateRetrieveRead,
} from "./retrieve.ts";
import { failedStreamEnvelope, streamEnvelope } from "./retrieve-stream.ts";

/** Changes allowed to wait unread before the follow ends (`transport/stream-overflow`). */
export const FOLLOW_BUFFER_LIMIT = 50_000;

export interface RetrieveFollowOptions {
	/** Ctrl-C: ends the follow with `stopReason: "interrupted"`. */
	signal?: AbortSignal;
	/** Fired once the `listen` is on the wire, before the snapshot `print`. */
	onListening?: () => void;
	/** Override {@link FOLLOW_BUFFER_LIMIT} (tests). */
	bufferLimit?: number;
}

type FollowEvent =
	| { type: "listen"; reply: ProtocolTappedReply; version?: number }
	| { type: "listen-end" }
	| { type: "snapshot-row"; row: Record<string, string> }
	| { type: "snapshot-done"; bootstrap?: Map<string, number> }
	| { type: "sweep-start" }
	| { type: "sweep"; ids: Set<string> }
	| {
			type: "membership";
			versions: Map<string, number>;
			rows: Map<string, Record<string, string>>;
	  }
	| { type: "stop" }
	| { type: "error"; error: unknown };

/**
 * The wire-ordered event queue: every source feeds it from a synchronous
 * reply tap (`ProtocolListenOptions.onReply`), so its order is the order the
 * replies arrived on the connection. A stop request and a fatal error jump the
 * queue: Ctrl-C, an elapsed `--duration` or an overflow must not wait behind
 * a backlog. Head-indexed, because `shift()` is O(n) per event.
 */
class FollowQueue {
	private events: FollowEvent[] = [];
	private head = 0;
	private wake: (() => void) | undefined;
	private stopRequested = false;
	private fatal: { error: unknown } | undefined;

	get length(): number {
		return this.events.length - this.head;
	}

	/** The first fatal error recorded, including one that arrived after the loop left. */
	get fatalError(): { error: unknown } | undefined {
		return this.fatal;
	}

	/**
	 * The stop or fatal error waiting to jump the queue, if any. A loop that
	 * yields a batch of frames between `next()` calls checks this per frame.
	 */
	halted(): FollowEvent | undefined {
		if (this.fatal) return { type: "error", error: this.fatal.error };
		if (this.stopRequested) return { type: "stop" };
		return undefined;
	}

	push(event: FollowEvent): void {
		this.events.push(event);
		this.signal();
	}

	requestStop(): void {
		this.stopRequested = true;
		this.signal();
	}

	fail(error: unknown): void {
		this.fatal ??= { error };
		this.signal();
	}

	async next(): Promise<FollowEvent> {
		for (;;) {
			const halted = this.halted();
			if (halted) return halted;
			if (this.head < this.events.length) {
				const event = this.events[this.head] as FollowEvent;
				this.head += 1;
				if (this.head > 1024 && this.head * 2 > this.events.length) {
					this.events.splice(0, this.head);
					this.head = 0;
				}
				return event;
			}
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}

	private signal(): void {
		const resume = this.wake;
		this.wake = undefined;
		resume?.();
	}
}

type FrameMeta = Extract<RetrieveStreamMeta, { kind: "frame" }>;

/**
 * Follow one menu: yields an optional `notice`, the snapshot frames, `synced`,
 * live frames, then exactly one summary (successful, or an error envelope
 * carrying the partial counts). Errors before the follow starts (resolution,
 * validation, a non-followable menu, a non-native transport) yield one error
 * envelope without a summary.
 */
export async function* retrieveFollow(
	request: RetrieveRequest,
	env: Record<string, string | undefined> = Bun.env,
	options: RetrieveFollowOptions = {},
): AsyncGenerator<RetrieveEnvelope, void, void> {
	const followRequest: RetrieveRequest = { ...request, follow: true };
	let resolved: ResolvedRetrieveRequest;
	try {
		resolved = await resolveRetrieveRequest(followRequest, env);
	} catch (error) {
		yield buildRetrieveErrorEnvelope(followRequest, error);
		return;
	}
	const startedAt = Date.now();
	// A caller that cancelled before the follow began gets its summary
	// without any device work.
	if (options.signal?.aborted) {
		yield interruptedSummary(
			resolved,
			{ enabled: resolved.validate.value, result: "skipped" },
			startedAt,
		);
		return;
	}
	if (resolved.via.value !== "native-api") {
		yield buildRetrieveErrorEnvelopeFromResolved(
			resolved,
			new CentrsError({
				code: "transport/capability-unsupported",
				summary: `\`retrieve --follow\` needs native-api; ${resolved.via.value} cannot follow a menu.`,
				remediation:
					"Use `--via native-api` (or leave `via` unset), and make sure the router's `api` service is enabled. There is no polling fallback.",
				context: { via: resolved.via.value, capability: "follow" },
			}),
		);
		return;
	}
	const backend = createProtocolAdapter({
		protocol: resolved.via.value,
		host: resolved.target.host,
		port: resolved.target.port,
		tls: resolved.target.tls,
		baseUrl: resolved.target.baseUrl,
		username: resolved.auth.username,
		password: resolved.auth.password,
		timeoutMs: resolved.timeoutMs.value,
		insecure: resolved.insecure?.value,
	});
	let prepared: Awaited<ReturnType<typeof validateFollow>>;
	try {
		prepared = await validateFollow(resolved, backend);
	} catch (error) {
		await backend.close();
		yield buildRetrieveErrorEnvelopeFromResolved(resolved, error);
		return;
	}
	if (options.signal?.aborted) {
		await backend.close();
		yield interruptedSummary(resolved, prepared.validation, startedAt);
		return;
	}
	yield* runFollow(
		resolved,
		backend,
		prepared.validation,
		options,
		startedAt,
		prepared.query,
	);
}

/**
 * The follow-only check: a list menu whose `print` takes `follow-only`
 * (#396 round 1: 0 mismatches over 403 menus on 7.23.7 and 7.24.5). Requested
 * attributes are checked as for a one-shot read. `--no-validate` skips both,
 * and RouterOS then rejects a non-followable `listen` itself.
 */
async function validateFollow(
	resolved: ResolvedRetrieveRequest,
	backend: ProtocolAdapter,
): Promise<Awaited<ReturnType<typeof validateRetrieveRead>>> {
	const prepared = await validateRetrieveRead(resolved, backend);
	if (!resolved.validate.value) {
		return prepared;
	}
	const inspection = prepared.inspection;
	if (!inspection) throw new Error("validated follow has no inspection");
	const followable =
		!inspection.singleton &&
		(
			await inspectArgumentNames(backend, [
				...pathTokens(resolved.path),
				"print",
			])
		).includes("follow-only");
	if (!followable) {
		throw new CentrsError({
			code: "validation/not-followable",
			summary: inspection.singleton
				? `${resolved.path} is a single record, which RouterOS cannot follow.`
				: `${resolved.path}/print has no \`follow-only\`, so RouterOS cannot follow this menu.`,
			remediation: `Read it once with \`centrs retrieve <router> ${resolved.path}\`, or read it on a timer with \`centrs retrieve <router> ${resolved.path} --sample 5s\`.`,
			context: {
				path: resolved.path,
				singleton: inspection.singleton,
				validationSource: "/console/inspect request=child",
			},
		});
	}
	return prepared;
}

async function* runFollow(
	resolved: ResolvedRetrieveRequest,
	backend: ProtocolAdapter,
	validation: EnvelopeValidationMeta,
	options: RetrieveFollowOptions,
	startedAt: number,
	query?: readonly string[],
): AsyncGenerator<RetrieveEnvelope, void, void> {
	const follow = resolved.follow ?? { sweepMs: 0 };
	const bufferLimit = options.bufferLimit ?? FOLLOW_BUFFER_LIMIT;
	const counts: RetrieveFollowCounts = {
		frames: 0,
		snapshot: 0,
		changes: 0,
		sweeps: 0,
		synced: false,
	};
	const tips = followTips(resolved);
	const controller = new AbortController();
	let stopReason: RetrieveFollowStopReason | undefined;
	let cancelUnacknowledged = false;

	// One wire-ordered queue for every source; `pending` holds listen replies
	// that arrived before the snapshot's `!done` (A1 replays them after it).
	const queue = new FollowQueue();
	const pending: Extract<FollowEvent, { type: "listen" }>[] = [];
	// Versions are advanced in the synchronous wire tap, not when a consumer
	// eventually drains the queue. A delayed membership reply cannot restore a
	// row after a newer change/deletion. Entries leave with their final result.
	const latest = new Map<string, number>();
	const dirty = new Map<string, number>();
	// Fixed at the snapshot's wire !done: newer changes stay live work and
	// cannot continually extend bootstrap or postpone its first sweep.
	const bootstrapPending = new Map<string, number>();
	let version = 0;
	let membershipRunning = false;
	let membershipSize = 0;
	let sweepRunning = false;
	let sweepDue = false;
	let snapshotComplete = false;
	// Cleared once the loop leaves: replies that land during teardown are not
	// read, so they must not count toward the overflow bound. Errors still do.
	let draining = true;
	const push = (event: FollowEvent): void => {
		if (event.type === "error") {
			queue.fail(event.error);
			return;
		}
		if (!draining) return;
		if (
			(event.type === "listen" || event.type === "snapshot-row") &&
			queue.length + pending.length + dirty.size + membershipSize >= bufferLimit
		) {
			queue.fail(overflowError(bufferLimit));
			return;
		}
		queue.push(event);
	};
	const stop = (reason: RetrieveFollowStopReason): void => {
		stopReason ??= reason;
		queue.requestStop();
		controller.abort();
	};
	/**
	 * Cancel the listen and wait for RouterOS's acknowledgement (bounded by
	 * the adapter's cancel grace), so the outcome is known before the summary.
	 */
	const endListen = async (): Promise<Warning[]> => {
		clearTimeout(durationTimer);
		clearTimeout(sweepTimer);
		controller.abort();
		await Promise.all(running);
		return cancelUnacknowledged ? [cancelUnacknowledgedWarning(resolved)] : [];
	};
	const durationTimer =
		follow.durationMs !== undefined
			? setTimeout(() => stop("duration-elapsed"), follow.durationMs)
			: undefined;
	const onExternalAbort = (): void => stop("interrupted");
	if (options.signal?.aborted) {
		// Aborting the internal signal too keeps `run` from dispatching anything.
		onExternalAbort();
		controller.abort();
	} else options.signal?.addEventListener("abort", onExternalAbort);

	const internalProplist =
		resolved.attributes.length > 0
			? [...new Set([".id", ".dead", ...resolved.attributes])]
			: undefined;
	const detail = resolved.allAttributes ? { detail: "" } : undefined;
	/**
	 * Run one native command, feeding the queue from its synchronous reply
	 * tap. The generator is only drained here; a failure becomes an `error`.
	 */
	const running = new Set<Promise<void>>();
	const run = (
		request: ProtocolApiRequest,
		onReply: (reply: ProtocolTappedReply) => void,
		extra: Partial<ProtocolListenOptions> = {},
	): void => {
		const drained = (async () => {
			try {
				for await (const _reply of backend.stream(request, {
					...extra,
					signal: controller.signal,
					onReply,
				})) {
					// Replies reach the queue through `onReply`, in wire order.
				}
				if (request.listen) push({ type: "listen-end" });
			} catch (error) {
				push({ type: "error", error });
			}
		})();
		running.add(drained);
		void drained.then(() => running.delete(drained));
	};
	/** `onReply` for a finite read: rows, then `done` unless it trapped. */
	const finite = (
		onRow: (row: Record<string, string>) => void,
		onDone: () => void,
	): ((reply: ProtocolTappedReply) => void) => {
		let trapped = false;
		return (reply) => {
			if (reply.type === "re") onRow(reply.attributes);
			else if (reply.type === "trap") trapped = true;
			else if (reply.type === "done" && !trapped) onDone();
		};
	};

	// The snapshot `print` goes out only once the `listen` is on the wire, on
	// the same connection, so every change after it is in the listen feed.
	run(
		{
			verb: "print",
			path: resolved.path,
			listen: true,
			proplist: internalProplist,
			attributes: detail,
		},
		(reply) => {
			if (reply.type === "re" || reply.type === "empty") {
				const id = reply.attributes[".id"];
				const current = query && id !== undefined ? ++version : undefined;
				if (draining && current !== undefined && id !== undefined)
					latest.set(id, current);
				push({ type: "listen", reply, version: current });
			}
		},
		{
			onListening: () => {
				options.onListening?.();
				run(
					{
						verb: "print",
						path: resolved.path,
						proplist: internalProplist,
						attributes: detail,
						query,
					},
					finite(
						(row) => push({ type: "snapshot-row", row }),
						() =>
							push({
								type: "snapshot-done",
								bootstrap: query ? new Map(latest) : undefined,
							}),
					),
				);
			},
			onCancelUnacknowledged: () => {
				cancelUnacknowledged = true;
			},
		},
	);

	// Held ids: what the consumer's state contains if it applied every line.
	const held = new Set<string>();
	// Ids touched by a listen reply since the in-flight sweep was sent; a sweep
	// never removes those (its snapshot may predate them).
	let touchedSinceSweep: Set<string> | undefined;
	let sweepTimer: ReturnType<typeof setTimeout> | undefined;
	const startSweep = (): void => {
		if (
			!sweepDue ||
			membershipRunning ||
			sweepRunning ||
			controller.signal.aborted
		)
			return;
		sweepDue = false;
		sweepRunning = true;
		push({ type: "sweep-start" });
		const ids = new Set<string>();
		run(
			{ verb: "print", path: resolved.path, proplist: [".id"], query },
			finite(
				(row) => ids.add(row[".id"] ?? ""),
				() => push({ type: "sweep", ids }),
			),
		);
	};
	const scheduleSweep = (): void => {
		if (follow.sweepMs <= 0 || controller.signal.aborted) return;
		sweepTimer = setTimeout(() => {
			if (controller.signal.aborted) return;
			sweepDue = true;
			startSweep();
		}, follow.sweepMs);
	};
	/** One bounded batch at a time. The unfiltered listen only identifies ids;
	 * the router returns current matching rows with the caller's projection. */
	const scheduleMembership = (): void => {
		if (
			!query ||
			membershipRunning ||
			sweepRunning ||
			sweepDue ||
			dirty.size === 0 ||
			controller.signal.aborted
		)
			return;
		const versions = new Map<string, number>();
		for (const id of bootstrapPending.keys()) {
			const current = dirty.get(id);
			if (current !== undefined) versions.set(id, current);
			if (versions.size === 256) break;
		}
		for (const [id, current] of dirty) {
			if (versions.size === 256) break;
			versions.set(id, current);
		}
		for (const id of versions.keys()) dirty.delete(id);
		const ids = [...versions.keys()];
		const selection = ids.flatMap((id, index) =>
			index === 0 ? [`.id=${id}`] : [`.id=${id}`, "#|"],
		);
		const rows = new Map<string, Record<string, string>>();
		membershipRunning = true;
		membershipSize = versions.size;
		run(
			{
				verb: "print",
				path: resolved.path,
				proplist: internalProplist,
				attributes: detail,
				query: [...selection, ...query, "#&"],
			},
			finite(
				(row) => {
					if (row[".id"] !== undefined) rows.set(row[".id"], row);
				},
				() => push({ type: "membership", versions, rows }),
			),
		);
	};

	const frame = (
		phase: FrameMeta["phase"],
		change: FrameMeta["change"],
		id: string,
		source: FrameMeta["source"],
		row: Record<string, string> | null,
	): RetrieveSuccessEnvelope => {
		counts.frames += 1;
		if (phase === "snapshot") counts.snapshot += 1;
		else counts.changes += 1;
		const data = row === null ? null : projectRow(row, resolved.attributes);
		return streamEnvelope(resolved, validation, data, {
			kind: "frame",
			index: counts.frames,
			phase,
			change,
			id,
			source,
		});
	};
	/** A listen reply as a frame, or `undefined` when it changes nothing held. */
	const applyListen = (
		event: Extract<FollowEvent, { type: "listen" }>,
		phase: FrameMeta["phase"],
	): RetrieveSuccessEnvelope | undefined => {
		const { reply } = event;
		// `!empty` on a listen is the cancel acknowledgement, never a table state.
		if (reply.type === "empty") return undefined;
		const id = reply.attributes[".id"];
		if (id === undefined) return undefined;
		touchedSinceSweep?.add(id);
		if (query) {
			if (event.version === undefined || event.version !== latest.get(id))
				return undefined;
			if (reply.attributes[".dead"] !== "true") {
				dirty.set(id, event.version);
				return undefined;
			}
			dirty.delete(id);
			latest.delete(id);
			bootstrapPending.delete(id);
		}
		if (reply.attributes[".dead"] === "true") {
			// A `.dead` for an id never reported is a coalesced add+delete.
			if (!held.delete(id)) return undefined;
			return frame(phase, "removed", id, "listen", null);
		}
		held.add(id);
		return frame(phase, "upsert", id, "listen", reply.attributes);
	};
	/**
	 * Between frames of one batch (the A1 replay, a sweep's removals): a stop
	 * ends the loop and a fatal error is thrown, without waiting for the batch.
	 */
	const haltRequested = (): boolean => {
		const halted = queue.halted();
		if (halted?.type === "error") throw halted.error;
		return halted !== undefined;
	};
	const countReached = (): boolean =>
		follow.count !== undefined && counts.changes >= follow.count;

	try {
		if (tips.length > 0) {
			yield streamEnvelope(
				resolved,
				validation,
				null,
				{ kind: "notice" },
				tips,
			);
		}
		loop: for (;;) {
			const event = await queue.next();
			switch (event.type) {
				case "listen": {
					if (!snapshotComplete) {
						pending.push(event);
						break;
					}
					const envelope = applyListen(
						event,
						counts.synced ? "live" : "snapshot",
					);
					if (envelope) {
						yield envelope;
						if (counts.synced && countReached()) {
							stopReason ??= "count-reached";
							break loop;
						}
					}
					break;
				}
				case "snapshot-row": {
					const id = event.row[".id"];
					if (id !== undefined) {
						held.add(id);
						yield frame("snapshot", "upsert", id, "print", event.row);
					}
					break;
				}
				case "snapshot-done": {
					snapshotComplete = true;
					for (const [id, current] of event.bootstrap ?? [])
						bootstrapPending.set(id, current);
					for (const reply of pending.splice(0, pending.length)) {
						if (haltRequested()) break loop;
						const envelope = applyListen(reply, "snapshot");
						if (envelope) yield envelope;
					}
					if (haltRequested()) break loop;
					if (query) break;
					counts.synced = true;
					yield streamEnvelope(resolved, validation, null, {
						kind: "synced",
						rows: held.size,
					});
					scheduleSweep();
					break;
				}
				case "membership": {
					membershipRunning = false;
					for (const [id, expected] of event.versions) {
						if (haltRequested()) break loop;
						membershipSize--;
						const initial = bootstrapPending.get(id);
						if (initial !== undefined && expected >= initial)
							bootstrapPending.delete(id);
						// A newer wire version invalidates this result, but it is
						// live work after the fixed bootstrap cutoff, not a reason
						// to extend initialization. Its dirty entry is retained.
						if (latest.get(id) !== expected) continue;
						latest.delete(id);
						const row = event.rows.get(id);
						const phase = counts.synced ? "live" : "snapshot";
						if (row) {
							held.add(id);
							yield frame(phase, "upsert", id, "membership", row);
						} else if (held.delete(id)) {
							yield frame(phase, "removed", id, "membership", null);
						}
						if (counts.synced && countReached()) {
							stopReason ??= "count-reached";
							break loop;
						}
					}
					break;
				}
				case "sweep-start":
					touchedSinceSweep = new Set();
					break;
				case "sweep": {
					sweepRunning = false;
					counts.sweeps += 1;
					const touched = touchedSinceSweep ?? new Set<string>();
					touchedSinceSweep = undefined;
					for (const id of [...held]) {
						if (
							event.ids.has(id) ||
							touched.has(id) ||
							(query && latest.has(id))
						)
							continue;
						if (haltRequested()) break loop;
						held.delete(id);
						yield frame(
							"live",
							"removed",
							id,
							query ? "membership" : "sweep",
							null,
						);
						if (countReached()) {
							stopReason ??= "count-reached";
							break loop;
						}
					}
					if (haltRequested()) break loop;
					scheduleSweep();
					break;
				}
				case "listen-end":
					stopReason ??= "completed";
					break loop;
				case "stop":
					break loop;
				case "error":
					throw event.error;
			}
			if (query) {
				if (haltRequested()) break;
				if (snapshotComplete && !counts.synced && bootstrapPending.size === 0) {
					counts.synced = true;
					yield streamEnvelope(resolved, validation, null, {
						kind: "synced",
						rows: held.size,
					});
					scheduleSweep();
				}
				startSweep();
				scheduleMembership();
			}
		}
		draining = false;
		const warnings = await endListen();
		// A command that failed while teardown waited (a sweep or snapshot trap
		// after `--count`/`--duration`) fails the follow, not a clean summary.
		const late = queue.fatalError;
		if (late) throw late.error;
		yield summaryEnvelope(
			resolved,
			validation,
			{ stopReason: stopReason ?? "completed", ...counts },
			Date.now() - startedAt,
			tips,
			warnings,
		);
	} catch (error) {
		draining = false;
		const warnings = await endListen();
		const envelope = failedStreamEnvelope(
			resolved,
			validation,
			error,
			(stopReason) => ({
				kind: "summary",
				stopReason,
				...counts,
				durationMs: Date.now() - startedAt,
			}),
			counts.frames,
		);
		envelope.warnings = [...envelope.warnings, ...warnings];
		envelope.tips = [...envelope.tips, ...tips];
		yield envelope;
	} finally {
		options.signal?.removeEventListener("abort", onExternalAbort);
		// A consumer that stopped reading early lands here directly.
		await endListen();
		await backend.close();
	}
}

function summaryEnvelope(
	resolved: ResolvedRetrieveRequest,
	validation: EnvelopeValidationMeta,
	counts: Omit<RetrieveFollowSummary, "durationMs">,
	durationMs: number,
	tips: Tip[],
	warnings: readonly Warning[],
): RetrieveSuccessEnvelope {
	const summary: RetrieveFollowSummary = { ...counts, durationMs };
	const envelope = streamEnvelope(
		resolved,
		validation,
		summary,
		{ kind: "summary", ...summary },
		tips,
	);
	if (envelope.meta.operation) {
		envelope.meta.operation.objectCount = counts.frames;
	}
	envelope.warnings = [...resolved.warnings, ...warnings];
	return envelope;
}

/** The summary of a follow cancelled before its listen went out. */
function interruptedSummary(
	resolved: ResolvedRetrieveRequest,
	validation: EnvelopeValidationMeta,
	startedAt: number,
): RetrieveSuccessEnvelope {
	return summaryEnvelope(
		resolved,
		validation,
		{
			stopReason: "interrupted",
			frames: 0,
			snapshot: 0,
			changes: 0,
			sweeps: 0,
			synced: false,
		},
		Date.now() - startedAt,
		[],
		[],
	);
}

/** Advice known before the first frame: what this follow will not report. */
function followTips(resolved: ResolvedRetrieveRequest): Tip[] {
	if ((resolved.follow?.sweepMs ?? 0) > 0) return [];
	return [
		buildTip(
			"tip/follow-sweep-off",
			"`--sweep 0` turned off the membership sweep, so removals RouterOS does not send (view menus such as `/interface/<type>`, `/ip/route`, `/ipv6/route`) will not be reported." +
				(resolved.query
					? " Silent exits from the predicate will also remain held until a listen notification arrives."
					: ""),
			"Leave `--sweep` at its default (10s), or follow the base menu (`/interface`, `/routing/route`), which reports its removals.",
		),
	];
}

/** `data` limited to the requested attributes; `.id`/`.dead` only when named. */
function projectRow(
	row: Record<string, string>,
	attributes: readonly string[],
): Record<string, string> {
	if (attributes.length === 0) return row;
	const projected: Record<string, string> = {};
	for (const attribute of attributes) {
		const value = row[attribute];
		if (value !== undefined) projected[attribute] = value;
	}
	return projected;
}

function overflowError(limit: number): CentrsError {
	return new CentrsError({
		code: "transport/stream-overflow",
		summary: `More than ${limit} changes were waiting unread, so centrs ended the follow instead of dropping any.`,
		remediation:
			"The state you hold is stale: follow again to take a new snapshot, and read lines as they arrive (or narrow the menu).",
		context: { bufferLimit: limit },
	});
}

function cancelUnacknowledgedWarning(
	resolved: ResolvedRetrieveRequest,
): Warning {
	return {
		code: "transport/cancel-unacknowledged",
		message: `RouterOS did not acknowledge /cancel within ${resolved.timeoutMs.value}ms; centrs closed the session locally.`,
		context: { timeoutMs: resolved.timeoutMs.value },
	};
}
