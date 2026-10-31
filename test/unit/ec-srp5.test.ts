/**
 * EC-SRP5 loopback: the client proof ({@link ecSrp5ClientProof}, the proven
 * `mtwei.c` port) and the net-new server role ({@link ecSrp5ServerShared} /
 * {@link ecSrp5ServerPublicKey}) must agree on the shared secret and the two
 * confirmation codes — the property a btest server↔client handshake relies on,
 * verified here without a router. The wire framing lives in `btest.ts`; this
 * pins only the crypto reconciliation grounded against `manawenuz/btest-rs`'s
 * `src/ecsrp5.rs` (MITM-verified vs RouterOS 7.x).
 */

import { describe, expect, test } from "bun:test";
import {
	bytesToBigIntBE,
	ecSrp5ClientConfirm,
	ecSrp5ClientProof,
	ecSrp5ClientShared,
	ecSrp5Id,
	ecSrp5Keygen,
	ecSrp5ServerConfirm,
	ecSrp5ServerPublicKey,
	ecSrp5ServerShared,
	encodePoint,
	redp1,
	sha256,
} from "../../src/protocols/ec-srp5.ts";
import { mtweiDocrypto } from "../../src/protocols/mtwei.ts";
import vectors from "../fixtures/ec-srp5.json";

const fromHex = (value: string): Uint8Array =>
	new Uint8Array(Buffer.from(value, "hex"));
const toHex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

describe("EC-SRP5 RouterOS minimal-length encodings (#565)", () => {
	for (const vector of [vectors.shortZ, ...vectors.redp1]) {
		test(`both roles match the reference transcript for salt ${vector.salt}`, () => {
			const validator = ecSrp5Id(
				vector.username,
				vector.password,
				fromHex(vector.salt),
			);
			expect(toHex(validator)).toBe(vector.validator);
			const clientArgs = [
				BigInt(`0x${vector.clientPrivate}`),
				fromHex(vector.serverKeyBlinded),
				fromHex(vector.clientKey),
				validator,
			] as const;
			expect(
				toHex(
					ecSrp5ServerPublicKey(
						BigInt(`0x${vector.serverPrivate}`),
						bytesToBigIntBE(validator),
					),
				),
			).toBe(vector.serverKeyBlinded);
			const client = ecSrp5ClientShared(...clientArgs);
			const server = ecSrp5ServerShared(
				BigInt(`0x${vector.serverPrivate}`),
				bytesToBigIntBE(validator),
				fromHex(vector.clientKey),
				fromHex(vector.serverKeyBlinded),
			);
			for (const shared of [client, server]) {
				expect(toHex(shared.j)).toBe(vector.j);
				expect(toHex(shared.z)).toBe(vector.zMinimal);
				const proof = ecSrp5ClientConfirm(shared);
				expect(toHex(proof)).toBe(vector.clientConfirmMinimal);
				expect(toHex(ecSrp5ServerConfirm(shared, proof))).toBe(
					vector.serverConfirmMinimal,
				);
			}
			expect(toHex(ecSrp5ClientProof(...clientArgs))).toBe(
				vector.clientConfirmMinimal,
			);
			expect(toHex(mtweiDocrypto(...clientArgs))).toBe(
				vector.clientConfirmMinimal,
			);
		});
	}

	for (const vector of vectors.redp1) {
		test(`${vector.edge} preserves the fixed 32-byte input and both point parities`, () => {
			const input = fromHex(vector.xGamma);
			expect(input.length).toBe(32);
			if (vector.edge === "redp1-loop") expect(sha256(input)[0]).toBe(0);
			else expect(input[0]).toBe(0);
			expect(toHex(encodePoint(redp1(input, 0)))).toBe(vector.gamma);
			expect(toHex(encodePoint(redp1(input, 1)))).toBe(
				`${vector.gamma.slice(0, -2)}01`,
			);
		});
	}

	test("short z differs from the old padded proof", () => {
		const vector = vectors.shortZ;
		expect(fromHex(vector.zMinimal).length).toBe(31);
		expect(toHex(sha256(fromHex(vector.j), fromHex(vector.zPadded)))).toBe(
			vector.clientConfirmPadded,
		);
		expect(vector.clientConfirmMinimal).not.toBe(vector.clientConfirmPadded);
	});
});

const USERNAME = "testuser";
const PASSWORD = "testpass";
const SALT = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

/** Deterministic keypairs so the loopback is reproducible. */
function fixtureKeys() {
	const client = ecSrp5Keygen(new Uint8Array(32).fill(7));
	const server = ecSrp5Keygen(new Uint8Array(32).fill(9));
	return { client, server };
}

describe("EC-SRP5 client ↔ server reconciliation", () => {
	test("matching credentials agree on (j, z) and both confirmations", () => {
		const { client, server } = fixtureKeys();

		// Validator i = SHA256(salt ‖ SHA256("user:pass")); both sides derive it.
		const validatorBytes = ecSrp5Id(USERNAME, PASSWORD, SALT);
		const validatorScalar = bytesToBigIntBE(validatorBytes);

		// Server advertises its blinded public key (btest MSG2).
		const serverPublic = ecSrp5ServerPublicKey(
			server.privateKey,
			validatorScalar,
		);

		// Client (MSG3) and server compute the shared secret independently.
		const clientShared = ecSrp5ClientShared(
			client.privateKey,
			serverPublic,
			client.publicKey,
			validatorBytes,
		);
		const serverShared = ecSrp5ServerShared(
			server.privateKey,
			validatorScalar,
			client.publicKey,
			serverPublic,
		);

		expect(serverShared.j).toEqual(clientShared.j);
		expect(serverShared.z).toEqual(clientShared.z);

		// Client confirmation (MSG3) — server must reproduce it to accept.
		const clientConfirm = ecSrp5ClientConfirm(clientShared);
		expect(ecSrp5ClientConfirm(serverShared)).toEqual(clientConfirm);

		// Server confirmation (MSG4) — client must reproduce it to accept.
		const serverConfirm = ecSrp5ServerConfirm(serverShared, clientConfirm);
		expect(ecSrp5ServerConfirm(clientShared, clientConfirm)).toEqual(
			serverConfirm,
		);
	});

	test("wrong password breaks the shared secret and confirmations", () => {
		const { client, server } = fixtureKeys();

		const correct = bytesToBigIntBE(ecSrp5Id(USERNAME, PASSWORD, SALT));
		const serverPublic = ecSrp5ServerPublicKey(server.privateKey, correct);

		// Client authenticates with the wrong password.
		const wrongValidator = ecSrp5Id(USERNAME, "wrongpass", SALT);
		const clientShared = ecSrp5ClientShared(
			client.privateKey,
			serverPublic,
			client.publicKey,
			wrongValidator,
		);
		const serverShared = ecSrp5ServerShared(
			server.privateKey,
			correct,
			client.publicKey,
			serverPublic,
		);

		expect(serverShared.z).not.toEqual(clientShared.z);
		expect(ecSrp5ClientConfirm(serverShared)).not.toEqual(
			ecSrp5ClientConfirm(clientShared),
		);
	});

	test("ecSrp5ClientProof equals SHA256(j ‖ z) from the shared secret", () => {
		const { client, server } = fixtureKeys();
		const validatorBytes = ecSrp5Id(USERNAME, PASSWORD, SALT);
		const serverPublic = ecSrp5ServerPublicKey(
			server.privateKey,
			bytesToBigIntBE(validatorBytes),
		);

		const proof = ecSrp5ClientProof(
			client.privateKey,
			serverPublic,
			client.publicKey,
			validatorBytes,
		);
		const shared = ecSrp5ClientShared(
			client.privateKey,
			serverPublic,
			client.publicKey,
			validatorBytes,
		);
		expect(proof).toEqual(ecSrp5ClientConfirm(shared));
	});
});
