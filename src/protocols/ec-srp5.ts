/**
 * EC-SRP5 — MikroTik's custom EC-SRP zero-knowledge password proof.
 *
 * MikroTik uses one EC-SRP family across MAC-Telnet (MTWEI), WinBox (EC-SRP5),
 * and the bandwidth test (btest): a Curve25519 group expressed in short
 * Weierstrass form, 32-byte big-endian Montgomery-X + 1 parity-byte point
 * encoding, identity `SHA256(salt ‖ SHA256("user:pass"))`, and proof
 * `SHA256(j ‖ z)`. This module is the **shared, protocol-agnostic** core — curve
 * constants, field/point math, point encoding, REDP1, keygen, the identity
 * validator, and the client proof. Per-protocol *framing* (how the public keys
 * and proof ride the wire) lives in the protocol module: `mtwei.ts` for
 * MAC-Telnet, `btest.ts` for the bandwidth test.
 *
 * This is a from-scratch, dependency-free port (BigInt field/point math +
 * node:crypto SHA-256) of the client side of Håkon Nessjøen's `mtwei.c`
 * (`haakonnessjoen/MAC-Telnet`, © Yandex 2022), cross-checked against the WinBox
 * EC-SRP5 reference (`Lab/winbox-terminal-protocol`) and `tikoci/m2ir`'s
 * `winbox-ipc/ec-srp5-handshake.yaml` (derived from MarginResearch's PoC). The
 * curve constants, point encoding, identity hash, and proof derivation match all
 * three, and the proof is accepted by real RouterOS over the MAC-Telnet L2
 * harness.
 */

import { createHash, randomBytes } from "node:crypto";
import { CentrsError } from "../errors.ts";

/** Client/server public key length: 32-byte Montgomery X + 1 parity byte. */
export const EC_SRP5_PUBKEY_LEN = 33;
/** Authentication proof / validator length. */
export const EC_SRP5_VALIDATOR_LEN = 32;

// ── Curve constants (verbatim from mtwei.c `mtwei_init`) ────────────────────
// Expressed via `BigInt("0x…")` rather than `0x…n` literals: CodeQL's JS
// extractor wrongly infers hex BigInt literals as possibly-undefined, which makes
// every downstream `+`/`*`/`%` here trip "implicit operand conversion". The
// constructor form is byte-identical (same hex value) and is correctly modelled
// as `bigint`, so the false positives go away without touching the math.
/** Field prime: 2^255 − 19. */
const P = BigInt(
	"0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed",
);
/** Short-Weierstrass curve coefficient a. */
const A = BigInt(
	"0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa984914a144",
);
/** Short-Weierstrass curve coefficient b. */
const B = BigInt(
	"0x7b425ed097b425ed097b425ed097b425ed097b425ed097b4260b5e9c7710c864",
);
/** Group order. */
const N = BigInt(
	"0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed",
);
/** Generator X (Weierstrass affine). */
const GX = BigInt(
	"0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad245a",
);
/** Generator Y (Weierstrass affine). */
const GY = BigInt(
	"0x5f51e65e475f794b1fe122d388b72eb36dc2b28192839e4dd6163a5d81312c14",
);
/** Weierstrass-X → Montgomery-X additive conversion (mtwei.c `w2m`). */
const W2M = BigInt(
	"0x555555555555555555555555555555555555555555555555555555555552db9c",
);
/** Montgomery-X → Weierstrass-X additive conversion (mtwei.c `m2w`). */
const M2W = BigInt(
	"0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad2451",
);
/** sqrt(−1) mod P, for the p ≡ 5 (mod 8) square-root path. */
const SQRT_M1 = modPow(2n, (P - 1n) / 4n, P);

/** An affine point, or `null` for the point at infinity. */
export type Point = { x: bigint; y: bigint } | null;

const G: Point = { x: GX, y: GY };

// ── Field arithmetic (mod P) ────────────────────────────────────────────────

function mod(value: bigint, m: bigint): bigint {
	const r = value % m;
	return r < 0n ? r + m : r;
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
	let result = 1n;
	let b = mod(base, m);
	let e = exp;
	while (e > 0n) {
		if (e & 1n) result = (result * b) % m;
		b = (b * b) % m;
		e >>= 1n;
	}
	return result;
}

/** Modular inverse via Fermat's little theorem (P is prime). */
function modInv(value: bigint): bigint {
	return modPow(value, P - 2n, P);
}

/**
 * Square root mod P. P ≡ 5 (mod 8), so a candidate is `a^((P+3)/8)`, adjusted
 * by sqrt(−1) when needed. Returns null if `a` is a non-residue.
 */
function modSqrt(a: bigint): bigint | null {
	const aa = mod(a, P);
	if (aa === 0n) return 0n;
	let x = modPow(aa, (P + 3n) / 8n, P);
	if ((x * x) % P === aa) return x;
	x = mod(x * SQRT_M1, P);
	if ((x * x) % P === aa) return x;
	return null;
}

// ── Byte/BigInt helpers (big-endian, matching OpenSSL BN_bin2bn) ─────────────

export function bytesToBigIntBE(bytes: Uint8Array): bigint {
	let value = 0n;
	for (const byte of bytes) value = (value << 8n) | BigInt(byte);
	return value;
}

export function bigIntToBytesBE(value: bigint, length: number): Uint8Array {
	const out = new Uint8Array(length);
	let v = value;
	for (let i = length - 1; i >= 0; i -= 1) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
}

export function sha256(...chunks: readonly Uint8Array[]): Uint8Array {
	const hash = createHash("sha256");
	for (const chunk of chunks) hash.update(chunk);
	return new Uint8Array(hash.digest());
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let cursor = 0;
	for (const part of parts) {
		out.set(part, cursor);
		cursor += part.length;
	}
	return out;
}

// ── Point arithmetic (short Weierstrass: y² = x³ + A·x + B mod P) ────────────

/** Is the point on the curve? (Infinity counts as on-curve.) */
export function isOnCurve(point: Point): boolean {
	if (point === null) return true;
	const lhs = mod(point.y * point.y, P);
	const rhs = mod(point.x * point.x * point.x + A * point.x + B, P);
	return lhs === rhs;
}

export function pointAdd(p: Point, q: Point): Point {
	if (p === null) return q;
	if (q === null) return p;
	if (p.x === q.x) {
		if (mod(p.y + q.y, P) === 0n) return null; // p + (−p) = ∞
		return pointDouble(p);
	}
	const slope = mod((q.y - p.y) * modInv(mod(q.x - p.x, P)), P);
	const x = mod(slope * slope - p.x - q.x, P);
	const y = mod(slope * (p.x - x) - p.y, P);
	return { x, y };
}

export function pointDouble(p: Point): Point {
	if (p === null) return null;
	if (p.y === 0n) return null;
	const slope = mod((3n * p.x * p.x + A) * modInv(mod(2n * p.y, P)), P);
	const x = mod(slope * slope - 2n * p.x, P);
	const y = mod(slope * (p.x - x) - p.y, P);
	return { x, y };
}

export function scalarMul(scalar: bigint, point: Point): Point {
	let result: Point = null;
	let addend = point;
	let k = scalar;
	while (k > 0n) {
		if (k & 1n) result = pointAdd(result, addend);
		addend = pointDouble(addend);
		k >>= 1n;
	}
	return result;
}

/**
 * Recover the point with the given Weierstrass X and Y parity (LSB of Y), or
 * null if X is not on the curve. Mirrors OpenSSL
 * `EC_POINT_set_compressed_coordinates`.
 */
export function liftX(xWeier: bigint, parity: number): Point {
	const x = mod(xWeier, P);
	const rhs = mod(x * x * x + A * x + B, P);
	const y0 = modSqrt(rhs);
	if (y0 === null) return null;
	const y = Number(y0 & 1n) === (parity & 1) ? y0 : mod(-y0, P);
	return { x, y };
}

// ── Point encoding: 32-byte big-endian Montgomery X + 1 parity byte ──────────

export function encodePoint(point: Point): Uint8Array {
	if (point === null) {
		throw new CentrsError({
			code: "routeros/ec-srp5-protocol",
			summary: "Cannot encode the EC-SRP5 point at infinity.",
			remediation: "Regenerate the keypair.",
		});
	}
	const out = new Uint8Array(EC_SRP5_PUBKEY_LEN);
	out.set(bigIntToBytesBE(mod(point.x + W2M, P), 32), 0);
	out[32] = Number(point.y & 1n);
	return out;
}

export function decodePoint(key: Uint8Array): Point {
	if (key.length !== EC_SRP5_PUBKEY_LEN) {
		throw new CentrsError({
			code: "routeros/ec-srp5-protocol",
			summary: `EC-SRP5 public key must be ${EC_SRP5_PUBKEY_LEN} bytes (got ${key.length}).`,
			remediation: "The peer sent a malformed key; confirm the device.",
		});
	}
	const xWeier = mod(bytesToBigIntBE(key.subarray(0, 32)) + M2W, P);
	const point = liftX(xWeier, key[32] as number);
	if (point === null) {
		throw new CentrsError({
			code: "routeros/ec-srp5-protocol",
			summary: "EC-SRP5 public key X is not a valid curve point.",
			remediation: "The peer sent a malformed key; confirm the device.",
		});
	}
	return point;
}

// ── EC-SRP5 primitives (ported from mtwei.c) ────────────────────────────────

export interface EcSrp5Keypair {
	/** Private scalar (clamped). */
	privateKey: bigint;
	/** 33-byte public key (Montgomery X + parity). */
	publicKey: Uint8Array;
}

/**
 * Generate a keypair. The 32-byte private scalar is clamped exactly as
 * `mtwei_keygen` does, then the public point is `priv·G` encoded to 33 bytes.
 * Pass `privBytes` for deterministic tests; random otherwise.
 */
export function ecSrp5Keygen(privBytes?: Uint8Array): EcSrp5Keypair {
	const priv = privBytes
		? Uint8Array.from(privBytes)
		: new Uint8Array(randomBytes(32));
	if (priv.length !== 32) {
		throw new CentrsError({
			code: "routeros/ec-srp5-protocol",
			summary: "EC-SRP5 private key seed must be 32 bytes.",
			remediation: "Pass a 32-byte seed or omit it for a random key.",
		});
	}
	// Clamp (verbatim byte ops from mtwei_keygen, interpreted big-endian).
	priv[0] = (priv[0] as number) & 248;
	priv[31] = (priv[31] as number) & 127;
	priv[31] = (priv[31] as number) | 64;
	const privateKey = bytesToBigIntBE(priv);
	return { privateKey, publicKey: encodePoint(scalarMul(privateKey, G)) };
}

/**
 * SRP identity validator: `SHA256(salt ‖ SHA256(username ‖ ":" ‖ password))`.
 * (`mtwei_id`.) The caller passes the login name with any `+...` console-param
 * suffix already stripped.
 */
export function ecSrp5Id(
	username: string,
	password: string,
	salt: Uint8Array,
): Uint8Array {
	const inner = sha256(new TextEncoder().encode(`${username}:${password}`));
	return sha256(salt, inner);
}

/**
 * REDP1 (IEEE P1363.2): deterministically derive a curve point from a 32-byte
 * Montgomery-X seed, incrementing until X lands on the curve. Mirrors the loop
 * inside `mtwei.c`'s `tangle`.
 */
export function redp1(montgomeryX: Uint8Array, parity: number): Point {
	let seed = bytesToBigIntBE(sha256(montgomeryX));
	for (;;) {
		const candidate = sha256(bigIntToBytesBE(seed, 32));
		const xWeier = mod(bytesToBigIntBE(candidate) + M2W, P);
		const point = liftX(xWeier, parity);
		if (point !== null) return point;
		seed = mod(seed + 1n, 1n << 256n);
	}
}

/**
 * Shared-secret material `(j, z)` common to both EC-SRP5 roles.
 *   j = SHA256(clientMontX ‖ serverMontX)  (the two 32-byte Montgomery Xs)
 *   z = Montgomery-X of the agreed shared point
 * The confirmation codes are derived from these (see {@link ecSrp5ClientConfirm}
 * / {@link ecSrp5ServerConfirm}).
 */
export interface EcSrp5Shared {
	j: Uint8Array;
	z: Uint8Array;
}

/**
 * **Client** shared secret (ECPESVDP-SRP-A).
 *
 *   v       = REDP1(MontX(validator·G), parity 1)   — undoes the server's blind
 *   w_b     = serverPoint + v                       — = serverEphemeral·G
 *   j       = SHA256(clientMontX ‖ serverMontX)
 *   scalar  = (validator·j + priv) mod N
 *   z       = MontX( scalar · w_b )
 *
 * `validator` is the `ecSrp5Id` identity (the scalar `i`), `serverKey` the peer's
 * 33-byte (possibly blinded) public key, `clientKey` our own 33-byte public key.
 */
export function ecSrp5ClientShared(
	privateKey: bigint,
	serverKey: Uint8Array,
	clientKey: Uint8Array,
	validator: Uint8Array,
): EcSrp5Shared {
	const serverPoint = decodePoint(serverKey);
	const v = bytesToBigIntBE(validator);

	// tangle: mix REDP1(v·G) into the server point (parity 1 for the client).
	const vG = scalarMul(v, G);
	if (vG === null) {
		throw new CentrsError({
			code: "routeros/ec-srp5-protocol",
			summary: "EC-SRP5 validator produced the point at infinity.",
			remediation: "Retry; this is astronomically unlikely.",
		});
	}
	const gamma = redp1(bigIntToBytesBE(mod(vG.x + W2M, P), 32), 1);
	const wB = pointAdd(serverPoint, gamma);

	const j = sha256(clientKey.subarray(0, 32), serverKey.subarray(0, 32));
	const scalar = mod(v * bytesToBigIntBE(j) + privateKey, N);
	const pt = scalarMul(scalar, wB);
	if (pt === null) {
		throw new CentrsError({
			code: "routeros/ec-srp5-protocol",
			summary: "EC-SRP5 shared point computed as infinity.",
			remediation: "The peer key may be invalid; confirm the device.",
		});
	}
	const z = bigIntToBytesBE(mod(pt.x + W2M, P), 32);
	return { j, z };
}

/**
 * Compute the 32-byte EC-SRP5 **client** authentication proof
 * (`mtwei_docrypto`): `SHA256(j ‖ z)`. Unchanged in bytes from the original
 * `mtwei.c` port — MAC-Telnet's MTWEI uses this directly.
 */
export function ecSrp5ClientProof(
	privateKey: bigint,
	serverKey: Uint8Array,
	clientKey: Uint8Array,
	validator: Uint8Array,
): Uint8Array {
	const { j, z } = ecSrp5ClientShared(
		privateKey,
		serverKey,
		clientKey,
		validator,
	);
	return sha256(j, z);
}

/**
 * **Server** blinded public key to advertise (MikroTik btest MSG2 /
 * `mtwei_docryptos`): `W_b = serverPrivate·G + REDP1(MontX(validator·G), 0)`.
 * The validator-derived blind hides whether the password is known; the client
 * removes it with the opposite-parity REDP1 (which is the point negation, so the
 * two cancel to `serverPrivate·G`). Returns the 33-byte encoded point.
 */
export function ecSrp5ServerPublicKey(
	serverPrivate: bigint,
	validatorScalar: bigint,
): Uint8Array {
	const pubB = scalarMul(serverPrivate, G);
	const validatorPoint = scalarMul(validatorScalar, G);
	if (pubB === null || validatorPoint === null) {
		throw new CentrsError({
			code: "routeros/ec-srp5-protocol",
			summary: "EC-SRP5 server key produced the point at infinity.",
			remediation: "Regenerate the server keypair.",
		});
	}
	const xGamma = encodePoint(validatorPoint).subarray(0, 32);
	const wB = pointAdd(pubB, redp1(xGamma, 0));
	return encodePoint(wB);
}

/**
 * **Server** shared secret (ECPESVDP-SRP-B).
 *
 *   gamma = validator·G          — the *raw* validator point (NOT REDP1; that
 *                                   only blinds the advertised key)
 *   j     = SHA256(clientMontX ‖ serverMontX)
 *   z     = MontX( serverPrivate · (clientPoint + j·gamma) )
 *
 * `serverKey` is the blinded key from {@link ecSrp5ServerPublicKey} (so `j`
 * matches the client's), `clientKey` the peer's 33-byte public key.
 */
export function ecSrp5ServerShared(
	serverPrivate: bigint,
	validatorScalar: bigint,
	clientKey: Uint8Array,
	serverKey: Uint8Array,
): EcSrp5Shared {
	const wA = decodePoint(clientKey);
	const gamma = scalarMul(validatorScalar, G);
	if (gamma === null) {
		throw new CentrsError({
			code: "routeros/ec-srp5-protocol",
			summary: "EC-SRP5 validator produced the point at infinity.",
			remediation: "The credentials are invalid; reconfigure the server.",
		});
	}
	const j = sha256(clientKey.subarray(0, 32), serverKey.subarray(0, 32));
	const sum = pointAdd(wA, scalarMul(bytesToBigIntBE(j), gamma));
	const pt = scalarMul(serverPrivate, sum);
	if (pt === null) {
		throw new CentrsError({
			code: "routeros/ec-srp5-protocol",
			summary: "EC-SRP5 shared point computed as infinity.",
			remediation: "The peer key may be invalid; confirm the client.",
		});
	}
	const z = bigIntToBytesBE(mod(pt.x + W2M, P), 32);
	return { j, z };
}

/** Client confirmation code: `SHA256(j ‖ z)` (equals {@link ecSrp5ClientProof}). */
export function ecSrp5ClientConfirm(shared: EcSrp5Shared): Uint8Array {
	return sha256(shared.j, shared.z);
}

/** Server confirmation code: `SHA256(j ‖ clientConfirm ‖ z)`. */
export function ecSrp5ServerConfirm(
	shared: EcSrp5Shared,
	clientConfirm: Uint8Array,
): Uint8Array {
	return sha256(shared.j, clientConfirm, shared.z);
}

/** Curve/order constants exposed for tests and protocol modules. */
export const ecSrp5Curve = { P, A, B, N, G } as const;
