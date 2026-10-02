# `validation/menu-unavailable`

RouterOS 7 publishes this menu, but this device does not have it — usually
hardware, build or version.

Same detection as
[`validation/package-missing`](package-missing.md): RouterOS rejected a path
segment, and centrs's path catalog knows the path. This code is used when the
published gates are not a package alone — a hardware capability
(`/interface/w60g` needs `60ghz`), a build condition, or no gate at all, which
usually means the device's RouterOS version predates or dropped the menu.

`error.context` carries `path`, `segment`, `gates` (root-first, each with the
`package`, `syscap` and `conditions` MikroTik published) and `detail`.

## Fix

The command is not the problem. Compare the gates with the device: installed
packages (`/system/package/print`), model, and RouterOS version
(`/system/resource/print`). Run the command only on devices that have the menu.
