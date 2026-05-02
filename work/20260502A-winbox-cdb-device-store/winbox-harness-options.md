# WinBox harness options

## Goal

Validate real WinBox CDB load/save behavior without turning `centrs` into a
brittle native-app automation project.

The current parser/writer and encrypted-CDB coverage are already grounded with
fixtures plus manual WinBox validation. The question here is which native-app
harness adds the most value next.

## What looks practical

### 1. Near-term: macOS WinBox 4 smoke harness

Recommended shape:

1. Launch the real macOS WinBox 4 app against a disposable test setup.
2. Use macOS Accessibility only for the thin UI steps:
   - focus the window,
   - open/select the target CDB,
   - trigger the minimal save/load action,
   - dismiss predictable dialogs.
3. Treat the file system as the oracle:
   - compare the saved `.cdb` bytes,
   - compare `settings.cfg.viw2` and workspace side effects,
   - record whether the app loaded the file without crashing.

Most practical tools:

- **Hammerspoon** for a lightweight local harness.
  - `hs.axuielement` can inspect and act on Accessibility elements.
  - `hs.application` can launch/focus WinBox.
  - `hs.eventtap` can send fallback key sequences.
- **XCTest/XCUIAutomation** if a more structured Apple-native test target is
  worth the setup cost.
- **SikuliX** only as a fallback when Accessibility identifiers are missing or
  unstable.

Why this is the best first harness:

- It works with the native app the operator already has.
- It keeps the assertions file-centric, which matters more than pixel-perfect
  UI checks for CDB work.
- It stays compatible with an explicit/manual-run model for now.

Current caveat:

- A plain `HOME=...` override was not enough to isolate WinBox support files on
  macOS. A real harness should use a stronger isolation boundary such as a
  disposable macOS user account or a VM snapshot.

### 2. Medium-term: Windows VM harness

Recommended shape:

1. Run WinBox inside a disposable Windows VM.
2. Drive only the few required UI actions.
3. Mount or copy fixture/scratch files in and out of the VM.
4. Reset the VM to a clean snapshot between runs.

Best tool choices:

- **pywinauto** for the fastest path to useful Windows automation.
- **FlaUI** if a C# / .NET harness is preferable.
- **WinAppDriver** only if Selenium/Appium-style orchestration is specifically
  desired.

Why Windows is the strongest repeatable path:

- Windows UI Automation is the most mature desktop-automation surface here.
- WinBox 3 is Windows-native, and WinBox 4 can also be exercised there.
- VM snapshots give cleaner replay than trying to isolate the macOS app
  profile in place.

### 3. Lower-confidence options

- **Linux + Wine + xdotool/SikuliX**
  - workable for coarse smoke checks,
  - not a strong default for trusted compatibility testing.
- **dogtail / LDTP**
  - interesting historically,
  - too weak or too stale to be the primary plan for WinBox.
- **QML debugger**
  - useful for inspection when a debug-enabled Qt build is available,
  - not a primary automation surface for production WinBox binaries.

## Recommendation matrix

| Path | Reliability | Effort | Portability | Best use |
| --- | --- | --- | --- | --- |
| macOS WinBox 4 + Hammerspoon/AX | Medium-high | Low-medium | macOS only | First explicit smoke harness |
| macOS WinBox 4 + XCTest/XCUI | Medium-high | Medium | macOS only | More structured Apple-native harness |
| macOS/Windows/Linux + SikuliX | Medium | Medium | Cross-platform | Fallback when accessibility is weak |
| Windows VM + pywinauto | High | Low-medium | Windows only | Best practical repeatable harness |
| Windows VM + FlaUI | High | Medium | Windows only | Stronger typed UIA harness |
| Windows + WinAppDriver/Appium | Medium | Medium-high | Windows only | Only if broader Appium plumbing matters |
| Linux/Wine + xdotool | Low-medium | Low | X11 only | Coarse smoke only |

## Suggested sequence for `centrs`

1. **Now:** keep fixture tests as the main contract and add a macOS explicit-run
   smoke harness around real WinBox 4 using Accessibility plus file diffs.
2. **Next:** when deeper replay matters, move the harness to a Windows VM and
   drive WinBox with `pywinauto` or FlaUI.
3. **Later:** only promote to CI when the environment can provide stable GUI
   sessions and resettable snapshots. A self-hosted Windows runner or a lab VM
   is more realistic than trying to force this into a generic headless hosted
   runner.

## Sources checked

- Apple XCTest / XCUIAutomation documentation:
  <https://developer.apple.com/documentation/xctest>
- Apple Mac automation guide:
  <https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/>
- Apple AppKit accessibility overview:
  <https://developer.apple.com/documentation/appkit/accessibility>
- Qt accessibility overview:
  <https://doc.qt.io/qt-6/accessible.html>
- Qt Quick accessibility:
  <https://doc.qt.io/qt-6/accessible-qtquick.html>
- Qt QML debugging infrastructure:
  <https://doc.qt.io/qt-6/qtquick-debugging.html>
- Hammerspoon Accessibility bindings:
  <https://www.hammerspoon.org/docs/hs.axuielement.html>
- Hammerspoon app/event helpers:
  <https://www.hammerspoon.org/docs/hs.application.html>
  <https://www.hammerspoon.org/docs/hs.eventtap.html>
- pywinauto:
  <https://github.com/pywinauto/pywinauto>
- FlaUI:
  <https://github.com/FlaUI/FlaUI>
- WinAppDriver:
  <https://github.com/microsoft/WinAppDriver>
- Appium Windows driver:
  <https://github.com/appium/appium-windows-driver>
- xdotool:
  <https://github.com/jordansissel/xdotool>
- dogtail:
  <https://github.com/dogtail/dogtail>
- AT-SPI:
  <https://wiki.linuxfoundation.org/accessibility/iaccessible2/atk/at-spi/at-spi_on_d-bus>
- LDTP:
  <https://ldtp.freedesktop.org/>
- SikuliX:
  <https://github.com/RaiMan/SikuliX1>
