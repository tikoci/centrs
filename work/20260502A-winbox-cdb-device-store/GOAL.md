# Goal: WinBox CDB device store grounding

## Problem

`centrs devices` likely needs WinBox CDB support early because CDB already models
saved RouterOS targets, groups, addresses, usernames, passwords, comments,
workspaces, and RoMON agent hints in a format RouterOS users understand.

The CDB format is secret-bearing and only partially grounded. Before any parser,
importer, writer, or default device-store behavior lands in source code, this
work item should turn CDB assumptions into evidence.

## Scope

- Inventory safe CDB fixtures under `test/fixtures/winbox-cdb/`.
- Ground open versus encrypted CDB files.
- Confirm entry identity, especially the apparent `address + user` key.
- Map WinBox UI terms and actions to `centrs` device-store concepts.
- Evaluate `CENTRS_CDB_FILE`, `CENTRS_CDB_PASSWORD`, `CENTRS_CDB_MODE`, and how
  they relate to `CENTRS_PASSWORD`.
- Decide whether CDB is canonical `centrs` storage, an import/export format, or
  one provider feeding a separate SQLite cache.

## Non-goals

- Implement a CDB parser or writer.
- Commit real private CDB files.
- Specify macOS Keychain or other long-term secret storage.
- Promote CDB settings into S004 before fixture-backed behavior is clear.

## Source material

- `work/20260430B-protocol-data-grounding/data-source-matrix.md`
- `work/20260430B-protocol-data-grounding/review-triage.md`
- `docs/specs/S003-device-discovery-and-cache.md`
- `docs/specs/S004-cli-settings-and-precedence.md`
- `test/fixtures/winbox-cdb/`
- `RouterOS_Tools` CDB implementation reference listed in the 20260430B
  reference inventory.
