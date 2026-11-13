# `routeros/no-such-item`

The RouterOS menu exists, but no item in it matches the `.id`, number or name
the command gave, so RouterOS refused it and that command did not run. In a
multi-statement script run through `/execute`, statements before the refused
one already ran.

## Emitted by

`execute`, `api` and `transfer` over `--via rest-api` and `--via native-api`.
RouterOS gives the same answer on each transport, so switching does not help.
Validation cannot catch it: the command is well formed, and only the device
knows which items exist.

## Context

- `detail`: RouterOS's message, verbatim. Over REST it is the whole
  `{"error":404,"message":"Not Found"}` body, because RouterOS sends no
  `detail` for this fault.
- `httpStatus`, `status`, `path`: the REST request, when REST carried it
  (HTTP 404).

## Typical triggers

- A name that is not there: `/system/script/run number=nosuch` gives
  `no such item` on the native API and HTTP 404 over REST *(CHR 7.25.1)*.
- An `.id` that is gone: `/ip/address/remove numbers=*FFFF` gives
  `no such item (4)` on the native API and HTTP 404 over REST
  *(CHR 7.25.1)*.
- The same command through `/execute`, as `execute` sends a console-form
  command: `/ip/address/set *FFFF comment=x` returns
  `no such item (4) (/ip/address/set; line 1)` on both transports
  *(CHR 7.25.1)*.
- A missing file: `/file/get .id=missing.txt` *(CHR 7.25.1)*. `transfer`
  reads this as "the file does not exist" and does not report it as an error.

## Fix

1. List the menu's items with `centrs retrieve <router> <menu>` and use an
   `.id` from that list. To match by name, filter:
   `centrs retrieve <router> /system/script --query 'name=backup'`.
2. Do not reuse a number from an earlier `print`: those numbers belong to the
   console session that printed them. Use the `.id` instead.
3. Before running a script again, check what its earlier statements changed.

## Related

- [`routeros/unknown-path`](unknown-path.md): the menu or command itself does
  not exist.
- [`routeros/invalid-value`](invalid-value.md): RouterOS rejected a value,
  not an item reference.
