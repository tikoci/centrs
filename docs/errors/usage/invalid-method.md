# `usage/invalid-method`

The -X/--method value is not a supported HTTP method.

## Fix

`centrs api` honors the HTTP method (`-X` / `--method`) literally against
RouterOS's REST verb map. The accepted methods are `GET`, `PUT`, `PATCH`,
`DELETE`, and `POST` (case-insensitive):

| Method | RouterOS verb        |
| ------ | -------------------- |
| `GET`  | print / get          |
| `PUT`  | add (RouterOS create) |
| `PATCH`| set                  |
| `DELETE`| remove              |
| `POST` | run a command        |

Pass one of those with `-X`, or omit the flag to use the default `GET`. Note the
trap: **`PUT` is RouterOS's create**, not `POST`.

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) for the centrs error
contract.
