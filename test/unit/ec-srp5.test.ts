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
} from "../../src/protocols/ec-srp5.ts";

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
