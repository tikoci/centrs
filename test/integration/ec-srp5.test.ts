/** Example 3: force #565 encoding edges against RouterOS's real btest client. */
import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { executeEnvelope } from "../../src/execute.ts";
import {
	BTEST_AUTH_EC_SRP5,
	BTEST_HELLO,
	encodeServerChallenge,
	parseClientHello,
} from "../../src/protocols/btest.ts";
import {
	type BtestControlChannel,
	channelFromSocket,
} from "../../src/protocols/btest-session.ts";
import {
	bytesToBigIntBE,
	decodePoint,
	ecSrp5ClientConfirm,
	ecSrp5Curve,
	ecSrp5ServerPublicKey,
	ecSrp5ServerShared,
	encodePoint,
	type Point,
	pointAdd,
	scalarMul,
	sha256,
} from "../../src/protocols/ec-srp5.ts";
import vectors from "../fixtures/ec-srp5.json";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;
const fromHex = (value: string): Uint8Array =>
	new Uint8Array(Buffer.from(value, "hex"));

async function readFrame(channel: BtestControlChannel): Promise<Uint8Array> {
	const length = (await channel.readExact(1))[0] as number;
	return channel.readExact(length);
}

describeFast("EC-SRP5 minimal-length RouterOS discriminators (#565)", () => {
	test("RouterOS proofs use minimal REDP1/z and retain the REDP1 input's zero byte", async () => {
		const started = await startIntegrationChr();
		try {
			// Each case isolates one edge: the two REDP1 vectors keep a random z,
			// and the last case forces a short z on top of the redp1-input vector.
			const cases = [
				...vectors.redp1.map((vector) => ({ vector, shortZ: false })),
				{
					vector: vectors.redp1.find((v) => v.edge === "redp1-input"),
					shortZ: true,
				},
			];
			for (const { vector, shortZ } of cases) {
				if (!vector) throw new Error("missing redp1-input vector");
				let socket: Socket | undefined;
				const peer = Promise.withResolvers<void>();
				const deadline = setTimeout(
					() => peer.reject(new Error("EC-SRP5 exchange timed out")),
					60_000,
				);
				// Register rejection handling before a peer can fail.
				void peer.promise.catch(() => {});
				const server = createServer((accepted) => {
					socket = accepted;
					accepted.setTimeout(45_000, () =>
						accepted.destroy(new Error("EC-SRP5 peer timed out")),
					);
					void (async () => {
						const channel = channelFromSocket(accepted);
						await channel.write(BTEST_HELLO);
						await channel.readExact(16);
						await channel.write(BTEST_AUTH_EC_SRP5);
						const hello = parseClientHello(await readFrame(channel));
						expect(hello.username).toBe(vector.username);
						const validator = bytesToBigIntBE(fromHex(vector.validator));
						let privateKey = BigInt(`0x${vector.serverPrivate}`);
						let publicKey = ecSrp5ServerPublicKey(privateKey, validator);
						expect(publicKey).toEqual(fromHex(vector.serverKeyBlinded));

						if (shortZ) {
							// Choose a short z after seeing the real client's ephemeral key.
							// Cache gamma and advance sB*G to keep this bounded search fast.
							const gamma = scalarMul(validator, ecSrp5Curve.G);
							const client = decodePoint(hello.publicKey);
							let serverPoint: Point = ecSrp5Curve.G;
							const blind = decodePoint(fromHex(vector.gamma));
							let found = false;
							for (let scalar = 1n; scalar <= 4096n; scalar++) {
								publicKey = encodePoint(pointAdd(serverPoint, blind));
								const j = sha256(
									hello.publicKey.subarray(0, 32),
									publicKey.subarray(0, 32),
								);
								const sharedPoint = scalarMul(
									scalar,
									pointAdd(client, scalarMul(bytesToBigIntBE(j), gamma)),
								);
								if (encodePoint(sharedPoint)[0] === 0) {
									privateKey = scalar;
									found = true;
									break;
								}
								serverPoint = pointAdd(serverPoint, ecSrp5Curve.G);
							}
							expect(found, "no short-z candidate in 4096 scalars").toBe(true);
						}

						const shared = ecSrp5ServerShared(
							privateKey,
							validator,
							hello.publicKey,
							publicKey,
						);
						if (shortZ) expect(shared.z.length).toBeLessThan(32);
						await channel.write(
							encodeServerChallenge(publicKey, fromHex(vector.salt)),
						);
						const proof = await readFrame(channel);
						expect(proof).toEqual(ecSrp5ClientConfirm(shared));
						if (shared.z.length < 32) {
							const padded = new Uint8Array(32);
							padded.set(shared.z, 32 - shared.z.length);
							expect(proof).not.toEqual(sha256(shared.j, padded));
						}
						// This discriminator stops at the real client's proof. The normal
						// btest suites cover confirmation and throughput in both roles.
						channel.close();
						console.log(
							`  ${vector.edge}${shortZ ? "+short-z" : ""}: RouterOS proof verified, z=${shared.z.length}B`,
						);
					})().then(peer.resolve, peer.reject);
				});
				try {
					await new Promise<void>((resolve, reject) => {
						server.once("error", reject);
						server.listen(2000, "127.0.0.1", resolve);
					});
					const launch = executeEnvelope(
						{
							quickchr: started.chr.name,
							command: `/tool/bandwidth-test address=10.0.2.2 protocol=tcp direction=receive user=${vector.username} password=${vector.password} duration=5s`,
							via: "rest-api",
							timeout: 55_000,
							yes: true,
						},
						{},
					).then((result) => {
						if (!result.ok)
							throw new Error(`${result.error.code}: ${result.error.summary}`);
					});
					// A validation/transport refusal must fail before waiting for a peer.
					await Promise.race([peer.promise, launch.then(() => peer.promise)]);
					await launch;
				} finally {
					clearTimeout(deadline);
					socket?.destroy();
					server.close();
				}
			}
			await recordIntegrationEvidence({
				suite: "EC-SRP5 minimal-length RouterOS discriminators (#565)",
				command: "btest",
				protocol: "btest",
				routerosVersion: started.chr.state.version,
				quickChrName: started.chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [3],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 240_000);
});
