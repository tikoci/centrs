# Fixture inventory: WinBox CDB

<!-- cspell:ignore nosaved owne mygroup mycomment nopassword -->

This inventory tracks the current synthetic fixture corpus under
`test/fixtures/winbox-cdb/`.

## Minimal and encryption coverage

| Fixture | Coverage |
| --- | --- |
| `min.cdb` | Minimal open CDB baseline. |
| `encrypted-min-with-one-normal-one-romon.cdb` | Encrypted CDB coverage with one normal row and one RoMON row. |

## IP-address target rows

| Fixture | Coverage |
| --- | --- |
| `admin-nosaved-password-no-group.cdb` | Admin user, no saved password, no group. |
| `admin-nosaved-password-profile-none.cdb` | Admin user, no saved password, `profile=none`. |
| `admin-with-saved-empty-password-profile-none.cdb` | Admin user, saved empty password, `profile=none`. |
| `admin-with-saved-empty-password-profile-owne.cdb` | Admin user, saved empty password, `profile=own` variant. |
| `user-with-saved-123-password-profile-none.cdb` | Non-admin user with saved password, `profile=none`. |
| `user-with-saved-123-password-profile-own.cdb` | Non-admin user with saved password, `profile=own`. |
| `user-with-saved-123-password-profile-own-with-group-mygroup.cdb` | Group coverage on a normal IP-target row. |
| `user-with-saved-123-password-profile-own-with-group-mygroup-with-comment-mycomment.cdb` | Comment coverage on a normal IP-target row. |
| `user-with-no-saved-password-profile-own-with-group-mygroup-with-comment-mycomment.cdb` | No-saved-password variant with group and comment. |

## Duplicate-key and merge/update coverage

These fixtures are the strongest current evidence that multiple rows can coexist
for the same address when the user identity differs, which is consistent with
the working `address + user` key hypothesis.

| Fixture | Coverage |
| --- | --- |
| `user-with-saved-123-password-profile-own-with-group-mygroup-with-comment-mycomment-and-admin-nopassword-on-same-ip-address-shows-two-entries.cdb` | Same IP, different users, two visible entries. |
| `user-with-saved-123-password-profile-own-with-group-mygroup-with-comment-mycomment-and-admin-nopassword-on-same-ip-address-with-saved-password-on-admin-shows-two-entries.cdb` | Same IP, different users, both saved-password behavior and two-entry visibility. |
| `user-with-saved-123-password-profile-own-with-group-mygroup-with-comment-mycomment-and-admin-nopassword-on-same-ip-address-with-saved-password-with-comments-with-group-on-admin-shows-two-entries.cdb` | Same IP, different users, both rows carry richer attributes. |

## MAC-address target rows

| Fixture | Coverage |
| --- | --- |
| `using-mac-address-no-saved-password-no-group-no-comments.cdb` | MAC target with the sparsest attribute set. |
| `using-mac-address-no-saved-password.cdb` | MAC target without saved password. |
| `using-mac-address-with-saved-password.cdb` | MAC target with saved password. |

## RoMON-oriented rows

| Fixture | Coverage |
| --- | --- |
| `romon-mac-saved-with-no-password-enabled-with-winbox-proxy-using-claude-saved.cdb` | RoMON + MAC + saved row without file-password coverage. |
| `romon-mac-saved-with-winbox-proxy-using-claude-saved-with-password.cdb` | RoMON + MAC + saved row with password-bearing coverage. |

## Remaining gaps

- No fixture currently documents field-length or escaping limits.
- The fixtures imply, but do not yet prove, exact update semantics for
  same-address same-user edits versus same-address different-user additions.
- Compatibility against a real WinBox build is still a local/manual smoke-check
  problem, not a CI-grade automated contract.
