# Local WinBox app observations

These notes summarize local, read-only observations from `WinBox.app` on macOS.

## What the app looks like

- WinBox is a native signed macOS app, not a browser-hosted UI.
- The bundle and runtime evidence point to Qt/QML rather than a web stack.
- Browser automation such as Playwright is therefore not the right primary tool.

## CLI and support-directory evidence

- `WinBox --help` exposes:

  ```text
  WinBox [options] connect-to username password workspace
  ```

- The positional `workspace` argument appears to be about the launched session
  workspace, not "load this CDB file".
- The app support directory is:

  ```text
  ~/Library/Application Support/MikroTik/WinBox/
  ```

  with at least:

  - `settings.cfg.viw2`
  - `workspaces/*.cfg.viw2`

- Current workspace files are named after the target with URL-encoding, for
  example `__192.168.88.3.cfg.viw2` and similar MAC-address based targets.
- The local `settings.cfg.viw2` file is Nova-like/`viw2`-shaped binary metadata,
  not the CDB itself. Readable strings include:

  - the current selected CDB path
  - table labels such as `LOGIN_SAVED_TABLE`, `LOGIN_NEIGH_TABLE`, and
    `LOGIN_ROMON_NEIGH_TABLE`
  - field names such as `Address`, `User`, `Group`, `RoMON Agent`, and
    `Workspace`

- The WinBox binary also contains the strings:

  - `/Addresses.cdb`
  - `CDB files (*.cdb)`
  - `/settings.cfg.viw2`
  - `/workspaces/`
  - `Workspace doesn't exist`

- A simple `HOME=/isolated/path` launch on macOS was **not** enough to sandbox the
  support state. WinBox still loaded the remembered CDB path from the normal
  profile (`/Users/amm0/test.cdb`) and did not create a fresh
  `Library/Application Support/MikroTik/WinBox/` tree under the overridden
  `HOME`.

## Automation assessment

- There is no useful AppleScript dictionary.
- Accessibility/System Events can detect the process and top-level window, but
  many controls are unnamed, which makes deep stable scripting fragile.
- `--qmljsdebugger=port:...` exists and may help exploratory reverse-engineering,
  but it is not a durable public test API.

## Practical test strategy

Use WinBox as a local/manual smoke oracle, not the primary compatibility engine.

1. Keep primary tests in `centrs` on synthetic `.cdb` fixtures and parser/import
   behavior.
2. Add an optional local smoke harness that launches WinBox in an isolated
   environment with a synthetic CDB.
3. Keep smoke assertions coarse: app launches, window appears, support files are
   written, and the process does not crash immediately.
4. Avoid deep UI automation unless a later native helper proves that the Qt/QML
   control tree exposes stable identifiers.

Today, "isolated environment" should mean a **disposable macOS user profile** or
another stronger OS-level isolation boundary, not just a temporary `HOME`
override.

## Safe local artifact

A sanitized analysis copy of `settings.cfg.viw2` is kept only in repo-local
scratch as `.scratch/settings.cfg.viw2`. It uses fake credentials and a neutral
demo path and should not be promoted into source or committed docs without a
stronger need.
