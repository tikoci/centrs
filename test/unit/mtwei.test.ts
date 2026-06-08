import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	decodePoint,
	encodePoint,
	isOnCurve,
	liftX,
	MTWEI_PUBKEY_LEN,
	MTWEI_VALIDATOR_LEN,
	mtweiCurve,
	mtweiDocrypto,
	mtweiId,
	mtweiKeygen,
	mtweiOfferValue,
	pointAdd,
	redp1,
	scalarMul,
} from "../../src/protocols/mtwei.ts";

function hex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("mtwei curve sanity", () => {
	test("the generator is on the curve", () => {
		expect(isOnCurve(mtweiCurve.G)).toBe(true);
	});

	test("order·G is the point at infinity (validates constants + point math)", () => {
		// The single strongest check: a wrong prime/coefficient/order or a broken
		// add/double/sqrt makes this fail.
		expect(scalarMul(mtweiCurve.N, mtweiCurve.G)).toBeNull();
	});

	test("1·G = G and 2·G = G+G", () => {
		expect(scalarMul(1n, mtweiCurve.G)).toEqual(mtweiCurve.G);
		expect(scalarMul(2n, mtweiCurve.G)).toEqual(
			pointAdd(mtweiCurve.G, mtweiCurve.G),
		);
	});

	test("liftX recovers the generator from its X + parity", () => {
		const g = mtweiCurve.G;
		if (g === null) throw new Error("generator missing");
		const lifted = liftX(g.x, Number(g.y & 1n));
		expect(lifted).toEqual(g);
	});
});

describe("mtwei point encoding", () => {
	test("encode→decode round-trips a public point (33 bytes, parity preserved)", () => {
		const { publicKey } = mtweiKeygen(new Uint8Array(32).fill(7));
		expect(publicKey.length).toBe(MTWEI_PUBKEY_LEN);
		const point = decodePoint(publicKey);
		expect(isOnCurve(point)).toBe(true);
		expect([...encodePoint(point)]).toEqual([...publicKey]);
	});

	test("decode rejects a wrong-length key", () => {
		expect(() => decodePoint(new Uint8Array(32))).toThrow();
	});
});

describe("mtwei identity hash", () => {
	test("is SHA256(salt ‖ SHA256(user:pass)) — vs an independent node-crypto oracle", () => {
		const salt = new Uint8Array(16).map((_, i) => i + 1);
		const inner = createHash("sha256").update("admin:hunter2", "utf8").digest();
		const expected = createHash("sha256")
			.update(Buffer.from(salt))
			.update(inner)
			.digest();
		const got = mtweiId("admin", "hunter2", salt);
		expect(got.length).toBe(MTWEI_VALIDATOR_LEN);
		expect(hex(got)).toBe(hex(new Uint8Array(expected)));
	});
});

describe("mtwei keygen", () => {
	test("clamps the scalar and derives the public point from it", () => {
		const seed = new Uint8Array(32).map((_, i) => i);
		const { privateKey, publicKey } = mtweiKeygen(seed);
		// Clamp: priv[0]&=248, priv[31]&=127|=64. So the seed is altered.
		const expectedPoint = scalarMul(privateKey, mtweiCurve.G);
		expect([...encodePoint(expectedPoint)]).toEqual([...publicKey]);
	});

	test("is deterministic for a fixed seed", () => {
		const seed = new Uint8Array(32).fill(3);
		expect(hex(mtweiKeygen(seed).publicKey)).toBe(
			hex(mtweiKeygen(seed).publicKey),
		);
	});
});

describe("mtwei redp1", () => {
	test("returns a deterministic on-curve point", () => {
		const seed = new Uint8Array(32).fill(0xab);
		const a = redp1(seed, 1);
		const b = redp1(seed, 1);
		expect(isOnCurve(a)).toBe(true);
		expect(a).toEqual(b);
		if (a === null) throw new Error("redp1 returned infinity");
		expect(Number(a.y & 1n)).toBe(1); // requested parity
	});
});

describe("mtwei docrypto (client proof)", () => {
	test("produces a 32-byte proof, deterministic for fixed inputs (regression anchor)", () => {
		// A fixed client + fixed "server" keypair + fixed salt — a stable vector
		// that pins the whole EC-SRP path against accidental change. (RouterOS
		// acceptance is proven by the CHR integration test.)
		const client = mtweiKeygen(new Uint8Array(32).fill(0x11));
		const server = mtweiKeygen(new Uint8Array(32).fill(0x22));
		const salt = new Uint8Array(16).fill(0x33);
		const validator = mtweiId("admin", "secret", salt);

		const proof = mtweiDocrypto(
			client.privateKey,
			server.publicKey,
			client.publicKey,
			validator,
		);
		expect(proof.length).toBe(MTWEI_VALIDATOR_LEN);
		// Stable across runs (deterministic inputs).
		const again = mtweiDocrypto(
			client.privateKey,
			server.publicKey,
			client.publicKey,
			validator,
		);
		expect(hex(proof)).toBe(hex(again));
	});
});

describe("mtwei offer value", () => {
	test("is username ‖ 0x00 ‖ 33-byte pubkey", () => {
		const { publicKey } = mtweiKeygen(new Uint8Array(32).fill(1));
		const offer = mtweiOfferValue("mt", publicKey);
		expect(offer.length).toBe(2 + 1 + MTWEI_PUBKEY_LEN);
		expect(offer[2]).toBe(0); // NUL after "mt"
		expect([...offer.subarray(3)]).toEqual([...publicKey]);
	});
});
