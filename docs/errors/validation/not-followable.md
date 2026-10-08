# `validation/not-followable`

The RouterOS menu cannot be followed: it is a single record, or its print has
no follow-only.

## When it happens

`centrs retrieve <router> <menu> --follow` checks the menu live through
`/console/inspect` before following it. RouterOS can follow a menu only when
its `print` takes `follow-only`, which is the same thing native-API `listen`
needs. Single-record menus such as `/system/resource`, `/system/identity` and
`/ip/dns` never take it, and neither do some list menus.

Nothing was followed. The error's `context.singleton` says which case it was.

## Fix

- Read the menu once: `centrs retrieve <router> <menu>`.
- To see a value change over time, sample it:
  `centrs api <router> <menu>/print -X POST -f interval=5s --stream`
  (one reply per tick, until `--count`, `--duration` or Ctrl-C).
- If you expected the menu to be followable, check the path with
  `centrs retrieve <router> <menu> --list-attributes`.
