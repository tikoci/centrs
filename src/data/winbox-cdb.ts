import { createHash, randomBytes } from "node:crypto";

const openFileMagic = Uint8Array.from([0x0d, 0xf0, 0x1d, 0xc0]);
const encryptedFileMagic = Uint8Array.from([0x0d, 0xf0, 0x11, 0x40]);
const recordMagic = Uint8Array.from([0x4d, 0x32]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const WINBOX_CDB_ENCRYPTED_SALT_LENGTH = 32;
export const WINBOX_CDB_RC4_DROP_BYTES = 0x300;

export const WINBOX_CDB_SAVED_PASSWORD_FLAG = 0x0100;

export const winBoxCdbFieldTag = {
	recordType: 1,
	user: 2,
	password: 3,
	comment: 4,
	session: 6,
	group: 8,
	commentMirror: 9,
	romonAgent: 11,
	profile: 12,
} as const;

export const winBoxCdbRecordType = {
	macTarget: 2,
	ipAdmin: 5,
	ipUser: 6,
	romonNeighbor: 7,
	romonTarget: 8,
} as const;

export type WinBoxCdbFieldValue =
	| bigint
	| boolean
	| number
	| string
	| Uint8Array
	| readonly number[];

export interface WinBoxCdbField {
	tag: number;
	marker: number;
	tcode: number;
	value: WinBoxCdbFieldValue;
}

export interface WinBoxCdbRecord {
	declaredFieldCount: number;
	flags: number;
	fields: readonly WinBoxCdbField[];
}

export interface OpenWinBoxCdbFile {
	mode: "open";
	records: readonly WinBoxCdbRecord[];
}

export interface EncryptedWinBoxCdbFile {
	mode: "encrypted";
	payload: Uint8Array;
}

export interface EncryptWinBoxCdbOptions {
	salt?: Uint8Array;
}

export class WinBoxCdbWrongPasswordError extends Error {
	constructor(message = "Wrong WinBox CDB password.") {
		super(message);
		this.name = "WinBoxCdbWrongPasswordError";
	}
}

export interface AnalyzeEncryptedWinBoxCdbOptions {
	blockSizes?: readonly number[];
	maxCandidateHeaderLength?: number;
	previewLength?: number;
}

export interface WinBoxCdbEncryptedBlockAlignment {
	blockSize: number;
	payloadRemainder: number;
	candidateHeaderLengths: readonly number[];
}

export interface WinBoxCdbEncryptedAnalysis {
	payloadLength: number;
	firstPayloadByte: number | undefined;
	lastPayloadByte: number | undefined;
	firstPayloadBytesHex: string;
	lastPayloadBytesHex: string;
	alignmentCandidates: readonly WinBoxCdbEncryptedBlockAlignment[];
}

export type WinBoxCdbFile = OpenWinBoxCdbFile | EncryptedWinBoxCdbFile;

export interface WinBoxCdbEntry {
	recordType: number;
	target: string;
	user: string;
	password: string;
	session: string;
	comment: string;
	commentMirror: string;
	group: string;
	profile: string;
	romonAgent: string;
	savedPassword: boolean;
	flags: number;
	record: WinBoxCdbRecord;
}

export interface BuildWinBoxCdbEntryInput {
	recordType: number;
	target: string;
	user?: string;
	password?: string;
	session?: string;
	comment?: string;
	commentMirror?: string;
	group?: string;
	profile?: string;
	romonAgent?: string;
	extraFields?: readonly WinBoxCdbField[];
	savedPassword?: boolean;
	flags?: number;
	declaredFieldCount?: number;
	fieldOrder?: readonly number[];
}

class ByteCursor {
	constructor(
		private readonly data: Uint8Array,
		private offset = 0,
	) {}

	remaining(): number {
		return this.data.length - this.offset;
	}

	readByte(): number {
		if (this.remaining() < 1) {
			throw new Error("Unexpected end of WinBox CDB data while reading byte.");
		}
		const value = this.data.at(this.offset);
		if (value === undefined) {
			throw new Error("Unexpected end of WinBox CDB data while reading byte.");
		}
		this.offset += 1;
		return value;
	}

	readSlice(length: number): Uint8Array {
		if (this.remaining() < length) {
			throw new Error(
				`Unexpected end of WinBox CDB data while reading ${length} byte(s).`,
			);
		}
		const start = this.offset;
		this.offset += length;
		return this.data.slice(start, this.offset);
	}

	readU16(): number {
		const slice = this.readSlice(2);
		const [b0, b1] = slice;
		if (b0 === undefined || b1 === undefined) {
			throw new Error("Unexpected end of WinBox CDB data while reading u16.");
		}
		return b0 | (b1 << 8);
	}

	readU32(): number {
		const slice = this.readSlice(4);
		const [b0, b1, b2, b3] = slice;
		if (
			b0 === undefined ||
			b1 === undefined ||
			b2 === undefined ||
			b3 === undefined
		) {
			throw new Error("Unexpected end of WinBox CDB data while reading u32.");
		}
		return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
	}

	readU64(): bigint {
		const low = BigInt(this.readU32());
		const high = BigInt(this.readU32());
		return low | (high << 32n);
	}
}

export function isWinBoxCdbOpen(data: Uint8Array): boolean {
	return hasPrefix(data, openFileMagic);
}

export function isWinBoxCdbEncrypted(data: Uint8Array): boolean {
	return hasPrefix(data, encryptedFileMagic);
}

export function parseWinBoxCdb(input: ArrayBuffer | Uint8Array): WinBoxCdbFile {
	const data = asUint8Array(input);
	if (isWinBoxCdbOpen(data)) {
		const cursor = new ByteCursor(data.slice(openFileMagic.length));
		const records: WinBoxCdbRecord[] = [];
		while (cursor.remaining() > 0) {
			const recordLength = cursor.readU32();
			const recordData = cursor.readSlice(recordLength);
			records.push(parseWinBoxCdbRecord(recordData));
		}
		return { mode: "open", records };
	}

	if (isWinBoxCdbEncrypted(data)) {
		return {
			mode: "encrypted",
			payload: data.slice(encryptedFileMagic.length),
		};
	}

	throw new Error(
		"Unsupported WinBox CDB file magic. Expected open or encrypted WinBox CDB bytes.",
	);
}

export function analyzeEncryptedWinBoxCdb(
	input: ArrayBuffer | Uint8Array | EncryptedWinBoxCdbFile,
	options: AnalyzeEncryptedWinBoxCdbOptions = {},
): WinBoxCdbEncryptedAnalysis {
	const blockSizes = options.blockSizes ?? [8, 16, 32];
	const maxCandidateHeaderLength = options.maxCandidateHeaderLength ?? 32;
	const previewLength = options.previewLength ?? 16;
	const encryptedFile =
		input instanceof Uint8Array || input instanceof ArrayBuffer
			? parseWinBoxCdb(input)
			: input;
	if (encryptedFile.mode !== "encrypted") {
		throw new Error(
			"Expected an encrypted WinBox CDB file for encrypted payload analysis.",
		);
	}

	const { payload } = encryptedFile;
	return {
		payloadLength: payload.length,
		firstPayloadByte: payload.at(0),
		lastPayloadByte: payload.at(-1),
		firstPayloadBytesHex: bytesToHex(payload.slice(0, previewLength)),
		lastPayloadBytesHex: bytesToHex(
			payload.slice(Math.max(0, payload.length - previewLength)),
		),
		alignmentCandidates: blockSizes.map((blockSize) => ({
			blockSize,
			payloadRemainder: payload.length % blockSize,
			candidateHeaderLengths: candidateHeaderLengths(
				payload.length,
				blockSize,
				maxCandidateHeaderLength,
			),
		})),
	};
}

export function decryptWinBoxCdb(
	input: ArrayBuffer | Uint8Array | EncryptedWinBoxCdbFile,
	password: string,
): Uint8Array {
	const encryptedFile =
		input instanceof Uint8Array || input instanceof ArrayBuffer
			? parseWinBoxCdb(input)
			: input;
	if (encryptedFile.mode !== "encrypted") {
		throw new Error(
			"Expected an encrypted WinBox CDB file for decryptWinBoxCdb.",
		);
	}
	const { payload } = encryptedFile;
	if (payload.length < WINBOX_CDB_ENCRYPTED_SALT_LENGTH) {
		throw new Error(
			"Encrypted WinBox CDB payload is shorter than the expected 32-byte salt.",
		);
	}
	const salt = payload.subarray(0, WINBOX_CDB_ENCRYPTED_SALT_LENGTH);
	const ciphertext = payload.subarray(WINBOX_CDB_ENCRYPTED_SALT_LENGTH);
	const plaintext = winBoxCdbStreamCipher(salt, password, ciphertext);
	if (!hasPrefix(plaintext, openFileMagic)) {
		throw new WinBoxCdbWrongPasswordError();
	}
	return plaintext;
}

export function encryptWinBoxCdb(
	openBytes: ArrayBuffer | Uint8Array,
	password: string,
	options: EncryptWinBoxCdbOptions = {},
): Uint8Array {
	const plaintext = asUint8Array(openBytes);
	if (!hasPrefix(plaintext, openFileMagic)) {
		throw new Error(
			"encryptWinBoxCdb expects open WinBox CDB bytes (must start with the open magic).",
		);
	}
	const salt = options.salt ?? randomBytes(WINBOX_CDB_ENCRYPTED_SALT_LENGTH);
	if (salt.length !== WINBOX_CDB_ENCRYPTED_SALT_LENGTH) {
		throw new Error(
			`WinBox CDB salt must be exactly ${WINBOX_CDB_ENCRYPTED_SALT_LENGTH} bytes; got ${salt.length}.`,
		);
	}
	const ciphertext = winBoxCdbStreamCipher(salt, password, plaintext);
	return concatChunks([encryptedFileMagic, salt, ciphertext]);
}

function winBoxCdbStreamCipher(
	salt: Uint8Array,
	password: string,
	data: Uint8Array,
): Uint8Array {
	const key = createHash("sha1").update(salt).update(password, "utf8").digest();
	const S = new Uint8Array(256);
	for (let k = 0; k < 256; k += 1) S[k] = k;
	let j = 0;
	for (let i = 0; i < 256; i += 1) {
		j = (j + (S[i] ?? 0) + (key[i % key.length] ?? 0)) & 0xff;
		const tmp = S[i] ?? 0;
		S[i] = S[j] ?? 0;
		S[j] = tmp;
	}
	let i = 0;
	j = 0;
	for (let k = 0; k < WINBOX_CDB_RC4_DROP_BYTES; k += 1) {
		i = (i + 1) & 0xff;
		j = (j + (S[i] ?? 0)) & 0xff;
		const tmp = S[i] ?? 0;
		S[i] = S[j] ?? 0;
		S[j] = tmp;
	}
	const out = new Uint8Array(data.length);
	for (let k = 0; k < data.length; k += 1) {
		i = (i + 1) & 0xff;
		j = (j + (S[i] ?? 0)) & 0xff;
		const tmp = S[i] ?? 0;
		S[i] = S[j] ?? 0;
		S[j] = tmp;
		const ks = S[((S[i] ?? 0) + (S[j] ?? 0)) & 0xff] ?? 0;
		out[k] = (data[k] ?? 0) ^ ks;
	}
	return out;
}

export function parseWinBoxCdbRecord(recordData: Uint8Array): WinBoxCdbRecord {
	if (!hasPrefix(recordData, recordMagic)) {
		throw new Error(
			"Invalid WinBox CDB record magic. Expected 'M2' record header.",
		);
	}

	const cursor = new ByteCursor(recordData.slice(recordMagic.length));
	const declaredFieldCount = cursor.readU16();
	const flags = cursor.readU16();
	const fields: WinBoxCdbField[] = [];

	while (cursor.remaining() > 0) {
		fields.push(parseWinBoxCdbField(cursor));
	}

	return { declaredFieldCount, flags, fields };
}

export function parseWinBoxCdbField(cursor: ByteCursor): WinBoxCdbField {
	const tag = cursor.readU16();
	const marker = cursor.readByte();
	const tcode = cursor.readByte();

	if (marker === 0x11) {
		return { tag, marker, tcode, value: cursor.readByte() };
	}

	switch (tcode) {
		case 0x20: {
			const length = cursor.readU16();
			return {
				tag,
				marker,
				tcode,
				value: textDecoder.decode(cursor.readSlice(length)),
			};
		}
		case 0x00:
			return { tag, marker, tcode, value: false };
		case 0x01:
			return { tag, marker, tcode, value: true };
		case 0x08:
			return { tag, marker, tcode, value: cursor.readU32() };
		case 0x09:
			return { tag, marker, tcode, value: cursor.readByte() };
		case 0x10:
			return { tag, marker, tcode, value: cursor.readU64() };
		case 0x21: {
			const length = cursor.readByte();
			return {
				tag,
				marker,
				tcode,
				value: textDecoder.decode(cursor.readSlice(length)),
			};
		}
		case 0x31: {
			const length = cursor.readByte();
			return { tag, marker, tcode, value: cursor.readSlice(length) };
		}
		case 0x88: {
			const count = cursor.readU16();
			const values: number[] = [];
			for (let index = 0; index < count; index += 1) {
				values.push(cursor.readU32());
			}
			return { tag, marker, tcode, value: values };
		}
		default:
			throw new Error(
				`Unsupported WinBox CDB field type 0x${tcode.toString(16).padStart(2, "0")}.`,
			);
	}
}

export function decodeWinBoxCdbEntries(
	file: OpenWinBoxCdbFile,
): WinBoxCdbEntry[] {
	return file.records.map((record) => decodeWinBoxCdbEntry(record));
}

export function decodeWinBoxCdbEntry(record: WinBoxCdbRecord): WinBoxCdbEntry {
	const typeField = firstNumericField(
		record.fields,
		winBoxCdbFieldTag.recordType,
		0x09,
	);
	if (typeField === undefined) {
		throw new Error("WinBox CDB record is missing its record-type field.");
	}

	return {
		recordType: typeField,
		target: lastStringField(record.fields, winBoxCdbFieldTag.recordType),
		user: firstStringField(record.fields, winBoxCdbFieldTag.user),
		password: firstStringField(record.fields, winBoxCdbFieldTag.password),
		session: firstStringField(record.fields, winBoxCdbFieldTag.session),
		comment: firstStringField(record.fields, winBoxCdbFieldTag.comment),
		commentMirror: firstStringField(
			record.fields,
			winBoxCdbFieldTag.commentMirror,
		),
		group: firstStringField(record.fields, winBoxCdbFieldTag.group),
		profile: firstStringField(record.fields, winBoxCdbFieldTag.profile),
		romonAgent: firstStringField(record.fields, winBoxCdbFieldTag.romonAgent),
		savedPassword: (record.flags & WINBOX_CDB_SAVED_PASSWORD_FLAG) !== 0,
		flags: record.flags,
		record,
	};
}

export function buildWinBoxCdbEntryRecord(
	input: BuildWinBoxCdbEntryInput,
): WinBoxCdbRecord {
	const savedPassword =
		input.savedPassword ??
		(input.password !== undefined && input.password.length > 0);
	const flags =
		input.flags ?? (savedPassword ? WINBOX_CDB_SAVED_PASSWORD_FLAG : 0);
	const commentMirror = input.commentMirror ?? input.comment ?? "";
	const fieldOrder =
		input.fieldOrder ??
		canonicalFieldOrder({
			savedPassword,
			profile: input.profile ?? "",
			romonAgent: input.romonAgent ?? "",
		});

	const valueByTag = new Map<number, string>([
		[winBoxCdbFieldTag.recordType, input.target],
		[winBoxCdbFieldTag.user, input.user ?? ""],
		[winBoxCdbFieldTag.password, input.password ?? ""],
		[winBoxCdbFieldTag.session, input.session ?? ""],
		[winBoxCdbFieldTag.comment, input.comment ?? ""],
		[winBoxCdbFieldTag.group, input.group ?? ""],
		[winBoxCdbFieldTag.commentMirror, commentMirror],
		[winBoxCdbFieldTag.romonAgent, input.romonAgent ?? ""],
		[winBoxCdbFieldTag.profile, input.profile ?? "<none>"],
	]);

	const fields: WinBoxCdbField[] = [
		{
			tag: winBoxCdbFieldTag.recordType,
			marker: 0xfe,
			tcode: 0x09,
			value: input.recordType,
		},
	];

	for (const tag of fieldOrder) {
		const value = valueByTag.get(tag) ?? "";
		fields.push({
			tag,
			marker: tag === winBoxCdbFieldTag.commentMirror ? 0xfe : 0x00,
			tcode: stringTcodeForValue(value),
			value,
		});
	}

	if (input.extraFields) {
		fields.push(...input.extraFields);
	}

	return {
		declaredFieldCount: input.declaredFieldCount ?? 7,
		flags,
		fields,
	};
}

export function encodeOpenWinBoxCdb(
	records: readonly WinBoxCdbRecord[],
): Uint8Array {
	const chunks: Uint8Array[] = [openFileMagic];
	for (const record of records) {
		const encoded = encodeWinBoxCdbRecord(record);
		chunks.push(encodeU32(encoded.length), encoded);
	}
	return concatChunks(chunks);
}

export function encodeWinBoxCdbRecord(record: WinBoxCdbRecord): Uint8Array {
	const fieldChunks = record.fields.map((field) => encodeWinBoxCdbField(field));
	const encoded = concatChunks([
		recordMagic,
		encodeU16(record.declaredFieldCount),
		encodeU16(record.flags),
		...fieldChunks,
	]);
	return encoded;
}

export function encodeWinBoxCdbField(field: WinBoxCdbField): Uint8Array {
	const header = concatChunks([
		encodeU16(field.tag),
		Uint8Array.from([field.marker, field.tcode]),
	]);
	return concatChunks([header, encodeFieldValue(field)]);
}

function encodeFieldValue(field: WinBoxCdbField): Uint8Array {
	if (field.marker === 0x11) {
		return Uint8Array.from([asByte(field.value)]);
	}

	switch (field.tcode) {
		case 0x20: {
			const bytes = textEncoder.encode(asString(field.value));
			if (bytes.length > 0xffff) {
				throw new Error("WinBox CDB string field exceeds 65535 bytes.");
			}
			return concatChunks([encodeU16(bytes.length), bytes]);
		}
		case 0x00:
		case 0x01:
			return new Uint8Array();
		case 0x08:
			return encodeU32(asU32(field.value));
		case 0x09:
			return Uint8Array.from([asByte(field.value)]);
		case 0x10:
			return encodeU64(asU64(field.value));
		case 0x21: {
			const bytes = textEncoder.encode(asString(field.value));
			if (bytes.length > 0xff) {
				throw new Error(
					"WinBox CDB 8-bit string field exceeds 255 bytes; use the 16-bit string type instead.",
				);
			}
			return concatChunks([Uint8Array.from([bytes.length]), bytes]);
		}
		case 0x31: {
			const bytes = asUint8ArrayValue(field.value);
			if (bytes.length > 0xff) {
				throw new Error("WinBox CDB blob field exceeds 255 bytes.");
			}
			return concatChunks([Uint8Array.from([bytes.length]), bytes]);
		}
		case 0x88: {
			const values = asNumberArray(field.value);
			return concatChunks([
				encodeU16(values.length),
				...values.map((value) => encodeU32(value)),
			]);
		}
		default:
			throw new Error(
				`Unsupported WinBox CDB field type 0x${field.tcode.toString(16).padStart(2, "0")}.`,
			);
	}
}

function firstStringField(
	fields: readonly WinBoxCdbField[],
	tag: number,
): string {
	for (const field of fields) {
		if (field.tag === tag && typeof field.value === "string") {
			return field.value;
		}
	}
	return "";
}

function lastStringField(
	fields: readonly WinBoxCdbField[],
	tag: number,
): string {
	for (let index = fields.length - 1; index >= 0; index -= 1) {
		const field = fields[index];
		if (!field) {
			continue;
		}
		if (field.tag === tag && typeof field.value === "string") {
			return field.value;
		}
	}
	return "";
}

function firstNumericField(
	fields: readonly WinBoxCdbField[],
	tag: number,
	tcode: number,
): number | undefined {
	for (const field of fields) {
		if (
			field.tag === tag &&
			field.tcode === tcode &&
			typeof field.value === "number"
		) {
			return field.value;
		}
	}
	return undefined;
}

function canonicalFieldOrder(input: {
	savedPassword: boolean;
	profile: string;
	romonAgent: string;
}): readonly number[] {
	if (
		input.savedPassword &&
		(input.profile !== "" || input.romonAgent !== "")
	) {
		return [
			winBoxCdbFieldTag.romonAgent,
			winBoxCdbFieldTag.profile,
			winBoxCdbFieldTag.group,
			winBoxCdbFieldTag.commentMirror,
			winBoxCdbFieldTag.comment,
			winBoxCdbFieldTag.password,
			winBoxCdbFieldTag.session,
			winBoxCdbFieldTag.user,
			winBoxCdbFieldTag.recordType,
		];
	}

	return [
		winBoxCdbFieldTag.recordType,
		winBoxCdbFieldTag.user,
		winBoxCdbFieldTag.password,
		winBoxCdbFieldTag.session,
		winBoxCdbFieldTag.comment,
		winBoxCdbFieldTag.commentMirror,
		winBoxCdbFieldTag.group,
		winBoxCdbFieldTag.profile,
		winBoxCdbFieldTag.romonAgent,
	];
}

function stringTcodeForValue(value: string): number {
	return textEncoder.encode(value).length > 0xff ? 0x20 : 0x21;
}

function candidateHeaderLengths(
	payloadLength: number,
	blockSize: number,
	maxCandidateHeaderLength: number,
): number[] {
	const candidates: number[] = [];
	const headerLimit = Math.min(maxCandidateHeaderLength, payloadLength - 1);
	for (let headerLength = 0; headerLength <= headerLimit; headerLength += 1) {
		if ((payloadLength - headerLength) % blockSize === 0) {
			candidates.push(headerLength);
		}
	}
	return candidates;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		" ",
	);
}

function asUint8Array(input: ArrayBuffer | Uint8Array): Uint8Array {
	return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function asUint8ArrayValue(value: WinBoxCdbFieldValue): Uint8Array {
	if (value instanceof Uint8Array) {
		return value;
	}
	throw new Error("Expected a Uint8Array WinBox CDB field value.");
}

function asString(value: WinBoxCdbFieldValue): string {
	if (typeof value === "string") {
		return value;
	}
	throw new Error("Expected a string WinBox CDB field value.");
}

function asByte(value: WinBoxCdbFieldValue): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > 0xff
	) {
		throw new Error("Expected a one-byte numeric WinBox CDB field value.");
	}
	return value;
}

function asU32(value: WinBoxCdbFieldValue): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > 0xffff_ffff
	) {
		throw new Error("Expected a 32-bit numeric WinBox CDB field value.");
	}
	return value >>> 0;
}

function asU64(value: WinBoxCdbFieldValue): bigint {
	if (
		typeof value === "bigint" &&
		value >= 0n &&
		value <= 0xffff_ffff_ffff_ffffn
	) {
		return value;
	}
	throw new Error("Expected a 64-bit bigint WinBox CDB field value.");
}

function asNumberArray(value: WinBoxCdbFieldValue): readonly number[] {
	if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) {
		return value;
	}
	throw new Error("Expected a numeric array WinBox CDB field value.");
}

function encodeU16(value: number): Uint8Array {
	return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff]);
}

function encodeU32(value: number): Uint8Array {
	return Uint8Array.from([
		value & 0xff,
		(value >>> 8) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 24) & 0xff,
	]);
}

function encodeU64(value: bigint): Uint8Array {
	return Uint8Array.from([
		Number(value & 0xffn),
		Number((value >> 8n) & 0xffn),
		Number((value >> 16n) & 0xffn),
		Number((value >> 24n) & 0xffn),
		Number((value >> 32n) & 0xffn),
		Number((value >> 40n) & 0xffn),
		Number((value >> 48n) & 0xffn),
		Number((value >> 56n) & 0xffn),
	]);
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function hasPrefix(data: Uint8Array, prefix: Uint8Array): boolean {
	if (data.length < prefix.length) {
		return false;
	}
	for (let index = 0; index < prefix.length; index += 1) {
		if (data[index] !== prefix[index]) {
			return false;
		}
	}
	return true;
}
