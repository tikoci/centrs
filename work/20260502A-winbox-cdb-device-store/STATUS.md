# Status: WinBox CDB device store grounding

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
  - WinBox network/session authentication and transport crypto.
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
- Those binary findings are only **hints**, not proof of the exact file format:
  they narrow the likely implementation family to a password-based KDF plus
  block-cipher wrapper, but they are not enough to safely implement encrypted
  CDB support yet.
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
- That constant 32-byte delta strongly suggests the encrypted wrapper is closer
  to `[32-byte per-file header][same-length ciphertext]` than to a naive
  AES-CBC-with-padding container.
- Simple backup-inspired hypotheses were tested locally against the smallest
  sample and did **not** hit:
  - RC4 keyed by `SHA1(salt || password)` / `SHA1(password || salt)`,
  - RC4 keyed by `SHA256(...)`,
  - AES-128-CTR with the 32-byte header split into salt/nonce material under
    the obvious SHA1/SHA256 derivations.
- The RouterOS password-protected backup format is therefore a weak fit for CDB:
  public backup tooling documents larger encrypted headers and different
  authenticated/enveloped structures than what the CDB samples show.

## Implementation checkpoint

- `src/data/winbox-cdb.ts` now implements:
  - open CDB file detection and parsing,
  - length-prefixed `M2` record decoding,
  - open CDB encoding,
  - encrypted payload geometry analysis for future sample comparison,
  - derived entry helpers for target, user, password, group, comment, profile,
    RoMON agent, and saved-password state.
- `test/unit/winbox-cdb.test.ts` now anchors:
  - minimal open-file parsing,
  - encrypted-file detection,
  - encrypted payload alignment analysis against the current encrypted fixture,
  - representative field decoding,
  - byte-for-byte round-trip of every open fixture,
  - generation of a fresh open CDB record and parse-back verification.
- The current implementation intentionally stops at **open CDB**. Encrypted CDB
  files are detected cleanly but not decrypted or rewritten yet.
- Neutral sample outputs for manual WinBox checks are generated in
  `.scratch/winbox-cdb-generated/`.
- Manual WinBox validation confirmed that the first generated batch of four open
  CDB files loaded successfully.
- Manual WinBox validation also confirmed that:
  - `session-plus-extra-field.cdb` loads after local edits,
  - `long-comment-255.cdb` loads after longer edits,
  - WinBox persists longer strings with the 16-bit string encoding now handled
    by the codec.
- The encrypted fixture remains intentionally opaque in code. Its current shape
  is:
  - 4-byte encrypted magic `0d f0 11 40`,
  - followed by a payload that is currently best explained as a 32-byte file
    header plus same-length ciphertext,
  - but still not grounded enough to decode safely.
- `analyzeEncryptedWinBoxCdb(...)` now provides a reusable way to compare
  encrypted payload geometry in code:
  - payload length,
  - first/last-byte previews,
  - candidate header lengths that leave a block-aligned remainder for selected
    block sizes.
- The current leading heuristic for future encrypted work is simpler than the
  earlier block-alignment guess: compare the first 32 bytes as likely file-level
  metadata and treat the remainder as same-length ciphertext until contrary
  evidence appears.
- Coverage now also includes:
  - known session-field handling (`tag 6`),
  - preservation of unknown extra string fields,
  - both 8-bit and 16-bit string encodings for open CDB string fields.

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
- For encrypted CDB work, use the library analysis helper first so new fixtures
  can be compared mechanically before any deeper crypto guesses are made.
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
- What algorithm and metadata wrap the encrypted CDB payload that starts with
  `0d f0 11 40`, and how does the WinBox file password map to that wrapper?
- Is the encrypted payload structured as `[small fixed header][salt/iv?][AES-CBC
  ciphertext]`, or is it actually `[32-byte header][stream/CTR-style ciphertext]`
  with no padding growth?
- What are the 32 bytes after `0d f0 11 40`:
  - pure salt,
  - salt plus nonce/counter seed,
  - salt plus integrity bytes,
  - or some MikroTik-specific mixed header?
- What is the smallest real-WinBox smoke that adds value beyond fixture-based
  parser tests without turning `centrs` into a brittle native-app automation
  project?

## Next experiments

1. Treat the open CDB codec as provisionally compatible and keep using
   `.scratch/winbox-cdb-generated/` only for targeted compatibility checks when a
   newly discovered field or encoding needs confirmation.
2. Ground the encrypted CDB wrapper and password handling well enough to add
   parse/decrypt support without guessing.
3. Separate file-format encryption questions from WinBox network/session crypto:
   the Margin Research EC-SRP/AES work is important background, but it is not
   by itself the local `.cdb` wrapper format.
4. Use the current manual encrypted-fixture matrix to compare the first 32 bytes
   against the remaining same-length ciphertext instead of treating the payload
   as a generic padded block cipher blob.
5. If the 32-byte-header model holds, search specifically for:
   - stream cipher / CTR-like file encryption,
   - a 32-byte salt or mixed header,
   - password KDFs that do **not** add explicit HMAC blocks to the file size.
6. If the black-box fixture matrix is still ambiguous, do a tighter local binary
   pass around the `saveWithPassword` / `getPasswordWindow` path instead of
   guessing from generic OpenSSL symbols.
7. Confirm whether a disposable macOS user profile is enough to relocate WinBox
   support files without touching the operator's normal profile.
8. Only if needed later, prototype a tiny native accessibility dumper to see
   whether Qt/QML controls expose stable identifiers worth scripting.
