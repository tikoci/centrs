# Status: WinBox CDB device store grounding

<!-- cspell:ignore alireza YATV wbx -->

## Current state

- Work item created from the May 1 protocol/data grounding review.
- Open CDB parsing and writing are implemented in `src/data/winbox-cdb.ts`.
- Real WinBox has now loaded the generated open `.cdb` samples, including the
  expanded edge-case batch with session/extra fields and longer edited text.
- Existing safe fixture names suggest coverage for empty/minimal files,
  saved-password and no-saved-password rows, MAC-address targets, groups,
  comments, RoMON-related entries, and encrypted examples.

## Evidence captured in this pass

- The fixture corpus is now inventoried in `fixture-inventory.md` and confirms
  deliberate coverage for:
  - minimal open and encrypted CDB files,
  - saved-password versus no-saved-password rows,
  - group and comment attributes,
  - MAC-address targets,
  - RoMON-oriented rows,
  - duplicate same-address rows with different users.
- Local WinBox app observations are recorded in
  `local-winbox-app-observations.md`.
- Candidate real-WinBox harness paths are recorded in
  `winbox-harness-options.md`.
- The local `settings.cfg.viw2` file is not the CDB itself. It is adjacent
  WinBox metadata that remembers the selected CDB path and stores login/workspace
  oriented tables and field labels.
- The WinBox CLI exposes a `workspace` positional argument, but no direct
  `--cdb` or equivalent flag was found for "load this CDB file".
- The WinBox bundle and runtime evidence point to a native Qt/QML app. Browser
  automation is therefore the wrong default tool, and macOS accessibility
  scripting looks suitable only for coarse smoke checks.
- A sanitized local analysis copy of `settings.cfg.viw2` now exists in
  repo-local scratch at `.scratch/settings.cfg.viw2`. It uses fake credentials
  and a neutral demo path.
- A simple `HOME=` override is not enough to isolate WinBox on macOS. In a local
  launch test, WinBox still loaded the remembered CDB path from the normal
  profile and did not create a fresh support tree under the overridden `HOME`.
- `jabb3rd/RouterOS_Tools` `readcdb.py` confirms the open CDB container shape and
  names known fields including host, login, password, note, session, group, and
  RoMON agent.
- `german77/TheDudeToHuman` reinforces the broader `M2`/TLV family model for
  Dude/Nova parsing, even though it does not directly explain the encrypted CDB
  wrapper.
- Real WinBox rewrites longer edited text fields with a distinct string tcode
  `0x20`, followed by a 16-bit little-endian byte length. The earlier open-file
  assumption that string fields stop at the `0x21` one-byte-length form was too
  narrow.
- The deeper public-source sweep still found **no** documented or implemented
  decoder for the encrypted WinBox CDB wrapper that starts with `0d f0 11 40`.
  The public references break down into:
  - open CDB parsers (`readcdb.py`),
  - old RouterOS `user.dat` obfuscation/extraction tooling,
  - WinBox network/session authentication and transport crypto,
  - **RouterOS password-protected backup tooling** (`BigNerd95/RouterOS-Backup-Tools`),
    which turned out to be the closest precedent — same RC4-drop[768] family,
    same `SHA1(salt || password)` KDF, just different magics and no length
    field. See `encrypted-cdb-format.md` for the precise mapping.
- The Margin Research and terminal-protocol references are useful for WinBox
  session/auth grounding, but they do **not** explain the local `.cdb`
  file-at-rest wrapper.
- A local WinBox binary probe found:
  - the hard-coded `/Addresses.cdb` path string,
  - UI/property strings such as `saveWithPassword`, `withPassword`, and
    `getPasswordWindow`,
  - linked and exported OpenSSL-era crypto entry points including
    `PKCS5_PBKDF2_HMAC`, `EVP_BytesToKey`, `AES_cbc_encrypt`, `RAND_bytes`,
    `SHA1`, and `SHA256`.
- Those binary findings were not enough on their own, but they did point at the
  correct password-based wrapper family and now corroborate the grounded
  `SHA1(salt || password)` + RC4-drop[768] implementation.
- A new manual encrypted sample set in
  `.scratch/winbox-cdb-encrypted-manually/` now gives grounded same-content and
  same-password comparison pairs.
- Across all currently grounded encrypted samples, the encrypted payload length
  is exactly **open file length + 32 bytes**:
  - `min.cdb` 4 bytes -> encrypted payload 36 bytes,
  - `user-with-saved-123-password-profile-none.cdb` 81 bytes -> encrypted
    payload 113 bytes,
  - the earlier synthetic encrypted fixture is also 32 bytes larger than the
    289-byte open RoMON fixture it was derived from.
- That constant 32-byte delta is now confirmed to be the cleartext random salt,
  followed by same-length RC4 ciphertext. With the captured salt reused,
  `encryptWinBoxCdb(...)` reproduces all four manual WinBox-generated encrypted
  files byte-for-byte.
- **Resolved 2026-05-02:** the encrypted CDB wrapper format is now grounded.
  Cross-referencing the WinBox macOS binary (`AddrsHandler::loadFromFile`
  → `PersistManager::readFile(QString,QString,bool,uint,uint,uint)` at
  `0x101898530`, KDF helper at `0x10189ab90`, `RC4::setKey`/`RC4::encrypt`
  at `0x1018f83a0`/`0x1018f84d0`) against the manual sample matrix gives:
  - 4-byte cleartext magic `0x4011F00D`,
  - 32-byte cleartext random salt (OpenSSL `RAND_bytes`),
  - ciphertext = RC4-drop[768] over the entire open `.cdb` content
    (including the open magic `0x0DF01DC0`),
  - key = `SHA1(salt || password_utf8)` (20 bytes),
  - password verify = first 4 plaintext bytes must equal `0x0DF01DC0`.
  All four manual samples (two passwords × two payloads) decrypt to
  identical plaintext, and a wrong password fails the magic check.
  Full write-up + reference TS implementation in
  `encrypted-cdb-format.md`.
- The earlier "32-byte file header + same-length ciphertext" geometry
  hypothesis was correct in shape — the 32 bytes are the random salt and
  the ciphertext is same-length because RC4 is a stream cipher.

## Implementation checkpoint

- `src/data/winbox-cdb.ts` now implements:
  - open CDB file detection and parsing,
  - length-prefixed `M2` record decoding,
  - open CDB encoding,
  - encrypted payload geometry analysis for fixture comparison,
  - encrypted CDB decrypt/encrypt via `SHA1(salt || password)` +
    RC4-drop[768],
  - derived entry helpers for target, user, password, group, comment, profile,
    RoMON agent, and saved-password state.
- `test/unit/winbox-cdb.test.ts` now anchors:
  - minimal open-file parsing,
  - encrypted-file detection,
  - encrypted payload alignment analysis against the current encrypted fixture,
  - representative field decoding,
  - byte-for-byte round-trip of every open fixture,
  - generation of a fresh open CDB record and parse-back verification,
  - byte-for-byte encrypt/decrypt round-trips for all open fixtures,
  - wrong-password rejection via the embedded open magic check,
  - byte-for-byte reproduction of all four manual WinBox-generated encrypted
    samples when their captured salts are reused.
- Neutral sample outputs for manual WinBox checks are generated in
  `.scratch/winbox-cdb-generated/`.
- Manual WinBox validation confirmed that the first generated batch of four open
  CDB files loaded successfully.
- Manual WinBox validation also confirmed that:
  - `session-plus-extra-field.cdb` loads after local edits,
  - `long-comment-255.cdb` loads after longer edits,
  - WinBox persists longer strings with the 16-bit string encoding now handled
    by the codec.
- `analyzeEncryptedWinBoxCdb(...)` now provides a reusable way to compare
  encrypted payload geometry in code before deeper comparison:
  - payload length,
  - first/last-byte previews,
  - candidate header lengths that leave a block-aligned remainder for selected
    block sizes.
- Coverage now also includes:
  - known session-field handling (`tag 6`),
  - preservation of unknown extra string fields,
  - both 8-bit and 16-bit string encodings for open CDB string fields.

## Cross-project follow-up (2026-05-04)

- The exploratory schema-IR/protocol-knowledge line that started in
  `work/20260502E-schema-ir-protocol-knowledge/` is now effectively carried by
  [tikoci/m2ir](https://github.com/tikoci/m2ir). The most relevant current
  follow-up note for this work item is
  `~/GitHub/m2ir/work/2026-05-winbox-nova-sources/winbox-nova-source-inventory.md`.
- That m2ir source sweep adds two useful public saved-session references:
  - `alireza-k7/winbox-wbx-to-cdb` **confirms** the open-file magic
    `0d f0 1d c0`, the `M2` record family, and the broad use of tags
    `1`, `2`, `3`, `4`, `8`, `9`, `11`, and `12`, which matches the family
    of fields already grounded in `src/data/winbox-cdb.ts`.
  - `YATV/WBX-tools` **expands** the upstream WBX side of the migration story:
    WBX signature `0f 10 c0 be`, `00 00` record separation, multiple TLV
    layouts (`L2`, `L1`, `L0`), and the user-facing field vocabulary
    `group`, `host`, `login`, `password`, `keep`, `note`, `type`, and
    `secure-mode`.
- Those same references also sharpen two caution points:
  - `alireza-k7/winbox-wbx-to-cdb` appears to treat the numeric `tag 1` field
    as a per-row index, while centrs's fixture-backed model treats that numeric
    field as the record type (`ipAdmin`, `ipUser`, `romonTarget`, etc.). Treat
    the repo as interoperability evidence, not as a stronger semantic source
    than the current centrs fixtures plus manual WinBox validation.
  - Its field-usage choices for `tag 8` / `tag 9` (`tag 8 = "mine"`,
    `tag 9 = note or group`) do not line up cleanly with centrs's current
    grounded mapping (`group = 8`, comment mirror / duplicated note field = 9).
    This is best read as sample-driven partial knowledge, not as a reason to
    weaken the existing centrs model.

## Working hypotheses

- CDB is a strong candidate for the first-class `centrs devices` data target.
- `address + user` appears to be the entry identity; group is an attribute.
- Comments/notes may carry RouterOS-style `key=value` metadata for non-default
  protocol ports or other per-device hints.
- CDB file passwords and RouterOS login passwords must be modeled separately even
  when a user chooses the same value for both.

## Deferred or rejected

- Direct implementation is deferred until fixture and compatibility evidence is
  reviewable.
- Automatic secret persistence is rejected.
- Automatic CDB encryption using an unrelated RouterOS password is rejected.
- Extending CDB records with new fields is rejected unless compatibility testing
  proves it safe.

## Validation and test strategy

- Treat synthetic `.cdb` fixtures plus parser/import tests as the primary
  compatibility contract for `centrs`.
- Treat real WinBox as a local/manual smoke oracle, not a CI-grade automation
  target.
- For encrypted CDB work, keep two checks paired:
  - use the library analysis helper first so new fixtures can be compared
    mechanically,
  - then prove the decrypt/encrypt mapping by reusing the captured salt and
    reproducing the original encrypted bytes exactly.
- If future work needs app-level confirmation, use a disposable macOS user
  profile or another stronger OS-level isolation boundary. A plain `HOME=...`
  override was not sufficient in local testing.
- Keep smoke assertions coarse:
  - process launches,
  - a window appears,
  - the generated `.scratch` CDB loads or fails in an informative way,
  - no immediate crash occurs when pointed at synthetic data.
- Avoid betting future implementation on deep accessibility scripting or the QML
  debugger unless a later native helper proves stable control identifiers.

## Open questions sharpened by this pass

- Is CDB the canonical long-term `centrs devices` store, or one explicit provider
  feeding a separate SQLite cache?
- What exact relationship should exist between the CDB file path remembered in
  `settings.cfg.viw2`, the active workspace, and the target-specific
  `workspaces/*.cfg.viw2` files?
- ~~What algorithm and metadata wrap the encrypted CDB payload~~ —
  resolved; see `encrypted-cdb-format.md`. Salt is 32 bytes random,
  cipher is RC4-drop[768] keyed by `SHA1(salt || password)`, no extra
  integrity field, no padding.
- What is the smallest real-WinBox smoke that adds value beyond fixture-based
  parser tests without turning `centrs` into a brittle native-app automation
  project?
- Should `centrs` accept the empty-password ("no master password") case
  as a distinct mode, or always require a non-empty password when the
  user opts into encryption? WinBox itself appears to allow it
  (the master-password dialog has a "no password" option).

## Next experiments

1. Treat the open CDB codec as provisionally compatible and keep using
   `.scratch/winbox-cdb-generated/` only for targeted compatibility checks when a
   newly discovered field or encoding needs confirmation.
2. ~~Ground the encrypted CDB wrapper and password handling~~ — done;
   `src/data/winbox-cdb.ts` now has working decrypt/encrypt support and the
   work item has a durable format note in `encrypted-cdb-format.md`. The next
   encryption work is policy and compatibility, not basic format discovery.
3. Separate file-format encryption questions from WinBox network/session crypto:
   the Margin Research EC-SRP/AES work is important background, but it is not
   by itself the local `.cdb` wrapper format.
4. Confirm whether a disposable macOS user profile is enough to relocate WinBox
   support files without touching the operator's normal profile.
5. Only if needed later, prototype a tiny native accessibility dumper to see
   whether Qt/QML controls expose stable identifiers worth scripting.
6. Decide how `centrs` should expose the encrypted-CDB password to the
   wider settings model (`CENTRS_CDB_PASSWORD` vs `CENTRS_PASSWORD` vs
   prompt-on-load) now that the wrapper crypto is no longer the unknown.
