# `cmr/console-only`

The command is one of CMR's interactive console views, so centrs refused it
before running it.

## Typical trigger

`/cmr/device/dashboard` through `execute` or `api`. On RouterOS 7.26beta1:

- over the **native API** it closed the API session;
- over **REST** it never returned, and every other REST request to the
  controller then waited 10–30 s until it timed out.

A plain path, abbreviated or not (`/cmr/dev/dash`), is refused before any
connection opens. Every other spelling is found in the controller's `:parse`
return during validation, which resolves it to one invocation: console
spacing, a relative menu change (`/cmr/device; dashboard`), a `:do`/`:if`
block, a `[...]` substitution, or an `api POST /execute` script. Strings and
comments that only spell the words are not refused.

With `--validate=false` there is no `:parse` return, so only the plain path is
refused.

## Fix

- Open the dashboard in WinBox 4 or WebFig, or run it in
  `centrs terminal <controller>`.
- For the data behind it, read the menus directly: `centrs retrieve
  <controller> /cmr/device`, `/cmr/alert` or `/cmr/upgrade/job`.
