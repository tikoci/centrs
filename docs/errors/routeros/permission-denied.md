# `routeros/permission-denied`

RouterOS refused the command because the user's group lacks a policy it needs.
The router answered, and a retry gives the same result. A single refused
command did not run. A multi-statement script run through `/execute` can be
partly applied: statements before the refused one already ran.

## Typical RouterOS strings

- `not enough permissions (9)`: the command needs a policy the group does not
  have, for example a `set` without `write`.
- `std failure: not allowed (9)`: on REST before RouterOS 7.26beta3, every
  request fails this way (a plain GET included) when the group has `rest-api`
  but not `api`. 7.26beta3 fixed it.

Over REST both arrive as HTTP 500 with the string in `detail`; over the native
API as a `!trap`. Grounded on CHR 7.23.8, 7.25, 7.26beta1 and 7.26beta3.

## Fix

Grant the missing policy to the user's group in `/user/group`: `read` for
reads, `write` for changes. Before 7.26beta3 a REST user needs both `api` and
`rest-api`. Avoid the built-in `read` group for a least-privilege user: it also
carries `reboot`, `sensitive`, `password` and others.
