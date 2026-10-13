# `cmr/console-only`

The command is one of CMR's interactive console views, so centrs refused it
before opening any connection.

## Typical trigger

`/cmr/device/dashboard` through `execute` or `api`. On RouterOS 7.26beta1:

- over the **native API** it closed the API session;
- over **REST** it never returned, and every other REST request to the
  controller then waited 10–30 s until it timed out.

centrs refuses it in any spelling: abbreviated (`/cmr/dev/dash`), with
console spacing, inside a multi-line script, or as an `api POST /execute`
script. It cannot follow a relative menu change across statements.

## Fix

- Open the dashboard in WinBox 4 or WebFig, or run it in
  `centrs terminal <controller>`.
- For the data behind it, read the menus directly: `centrs retrieve
  <controller> /cmr/device`, `/cmr/alert` or `/cmr/upgrade/job`.
