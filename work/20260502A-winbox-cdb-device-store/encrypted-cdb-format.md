# Encrypted WinBox CDB format

Grounded by cross-referencing the WinBox macOS binary at
`/Applications/WinBox.app/Contents/MacOS/WinBox` against the manual sample
matrix in `.scratch/winbox-cdb-encrypted-manually/`. All four encrypted
samples decrypt cleanly with the algorithm below; both passwords (`123`,
`321`) round-trip; cross-decryption with the wrong password produces a
plaintext whose first 4 bytes are not `0d f0 1d c0` (the open CDB magic),
which is exactly the verification check the binary performs.

## File layout

```text
offset 0   : 4 bytes  magic = 0x4011F00D       (little-endian: 0d f0 11 40)
offset 4   : 32 bytes salt   (random per save, source: OpenSSL RAND_bytes)
offset 36  : N bytes  ciphertext               (N = full open-file length)
```

Total encrypted file size = open file size + 36 bytes. No padding.

The 4-byte magic is cleartext; the 32-byte salt is cleartext; everything
after offset 36 is RC4-keystream-XORed plaintext. The plaintext is the
*entire* open `.cdb` file content, including its own `0d f0 1d c0` magic
at plaintext offset 0. WinBox uses that embedded open magic as a
password-correctness check before continuing to parse records.

## Cipher

RC4 in drop-768 form, keyed by a single SHA-1 hash:

```text
key = SHA1(salt || password_utf8)        # 20 bytes
RC4_KSA(key)                              # standard 256-byte permutation init
discard 0x300 (768) bytes of keystream
xor remaining keystream against ciphertext
```

The password is the UTF-8 byte form of the user-entered string; the
length used by the SHA-1 update is just the password byte length (no
trailing null and no length prefix). The 768-byte drop matches the
in-binary loop counter `0x300` immediately after `RC4::setKey`.

## Verifying the password

Decrypt only the first 4 bytes of ciphertext. If those equal the open
magic `0d f0 1d c0` (little-endian `0xC01DF00D`), the password is
correct. WinBox does this exact compare in
`PersistManager::readFile(QString,QString,bool,uint,uint,uint)`:

```text
… read 32-byte salt …
… RC4_setup_with_salt_and_password(state, salt, password) …
… RC4::encrypt(ciphertext[0..4]) …
cmp result, 0xC01DF00D
```

The function symbol decoded is `__ZN14PersistManager8readFileERK7QStringS2_bjjj`
at VM 0x101898530 in the x86_64 slice; the KDF lives at VM 0x10189ab90;
RC4 is in `__ZN3RC4...` symbols (`setKey`, `encrypt`).

## How this was confirmed

1. `min.cdb` open file is exactly 4 bytes (`0d f0 1d c0`). The two
   encrypted siblings are both 40 bytes = 4 magic + 32 salt + 4 ciphertext.
   That gives a fully known plaintext for the first 4 ciphertext bytes.
2. Decrypting `encrypted-min-123.cdb` with `password="123"` and
   `encrypted-min-321.cdb` with `password="321"` both yield exactly
   `0d f0 1d c0`.
3. Decrypting both 117-byte `encrypted-user-with-saved-…` files with their
   respective passwords yields **byte-identical** 81-byte plaintext.
4. Decrypting either user file with a wrong password yields a 4-byte
   prefix that is not `0d f0 1d c0`, matching the binary's check.
5. The single byte difference between that recovered plaintext and the
   adjacent open `user-with-saved-123-password-profile-none.cdb` fixture
   is at plaintext offset 18 (record-type field): the encrypted samples
   carry `0x08` (`romonTarget`), the open sample has `0x06` (`ipUser`).
   Both are valid records — the operator clearly clicked save with a
   different record-type selection between dumps. It is **not** a
   decryption bug.

## Reference implementation

```ts
import { createHash } from "node:crypto";

const ENCRYPTED_MAGIC = Uint8Array.from([0x0d, 0xf0, 0x11, 0x40]);
const OPEN_MAGIC = Uint8Array.from([0x0d, 0xf0, 0x1d, 0xc0]);
const SALT_LENGTH = 32;
const RC4_DROP_BYTES = 0x300;

function rc4KsaPrga(
  key: Uint8Array,
  drop: number,
  data: Uint8Array,
): Uint8Array {
  const S = new Uint8Array(256);
  for (let k = 0; k < 256; k++) S[k] = k;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
  }
  let i = 0;
  j = 0;
  // discard `drop` bytes of keystream
  for (let k = 0; k < drop; k++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
    const ks = S[(S[i] + S[j]) & 0xff];
    out[k] = data[k] ^ ks;
  }
  return out;
}

export function decryptWinBoxCdb(file: Uint8Array, password: string): Uint8Array {
  if (
    file.length < 4 + SALT_LENGTH ||
    file[0] !== ENCRYPTED_MAGIC[0] ||
    file[1] !== ENCRYPTED_MAGIC[1] ||
    file[2] !== ENCRYPTED_MAGIC[2] ||
    file[3] !== ENCRYPTED_MAGIC[3]
  ) {
    throw new Error("not an encrypted WinBox CDB");
  }
  const salt = file.subarray(4, 4 + SALT_LENGTH);
  const ciphertext = file.subarray(4 + SALT_LENGTH);
  const key = createHash("sha1").update(salt).update(password).digest();
  const plaintext = rc4KsaPrga(key, RC4_DROP_BYTES, ciphertext);
  if (
    plaintext[0] !== OPEN_MAGIC[0] ||
    plaintext[1] !== OPEN_MAGIC[1] ||
    plaintext[2] !== OPEN_MAGIC[2] ||
    plaintext[3] !== OPEN_MAGIC[3]
  ) {
    throw new Error("wrong password (open magic missing in plaintext)");
  }
  return plaintext;
}
```

The encrypt direction is the same code path: prepend `0x4011F00D`,
append a freshly generated 32-byte salt, derive the key the same way,
RC4-drop-768 keystream over the open-file bytes (which already start with
`0x0d 0xf0 0x1d 0xc0`).

## Relationship to RouterOS backup format

The scheme is essentially the v6.0–v6.42 RouterOS password-protected
backup format from
`https://github.com/BigNerd95/RouterOS-Backup-Tools` (RC4 mode), with
three differences:

| Field            | RouterOS backup (RC4)        | WinBox CDB (encrypted)       |
| ---------------- | ---------------------------- | ---------------------------- |
| Outer magic      | `0x7291A8EF`                 | `0x4011F00D`                 |
| Length field     | 4-byte file size after magic | none (no explicit length)    |
| Salt             | 32 bytes (first 16 random)   | 32 bytes (all random)        |
| KDF              | `SHA1(salt \|\| password)`   | `SHA1(salt \|\| password)`   |
| Cipher           | RC4-drop[768]                | RC4-drop[768]                |
| Password verify  | first 4 bytes == `0xB1A1AC88`| first 4 bytes == `0xC01DF00D`|

So the public RouterOS-backup tooling is the closest existing reference
code; the only new pieces here are the magic, the no-length wrapper, and
the verification constant.
