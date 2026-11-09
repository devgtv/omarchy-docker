# Changelog

## 1.1.0 (unreleased)

### Added

- Effective Docker context/host-override information with local-socket or network labeling.
- Stopped containers in the list, textual states and running/total counts.
- Start, Stop and Restart controls with per-container/per-target confirmation. Cancel is selected by default, and closing the panel cancels an unconfirmed action.
- Keyboard shortcuts: `s` for start/stop, `Shift+r` for restart, `g` for recent logs and `Shift+g` for live logs.
- Default-terminal log viewing with the last 200 timestamped lines, optional following and independent terminal windows.
- Fake Docker CLI collector tests and controller regressions for the new operations.

### Changed

- Snapshots and operations explicitly select the captured context or host override instead of relying on the mutable default context.
- Lifecycle and RAM operations use full container IDs and do not run concurrently.
- Stats are collected only for running IDs from the inspected snapshot; stopped containers have no RAM controls.
- Snapshots started before a write are discarded and refreshed.
- Lifecycle progress, success and failure feedback is shown in the panel.
- Qualify the theme color singleton to avoid a QML color-name collision observed during runtime smoke testing.

### Validation notes

- Automated controller/collector tests use mocks for lifecycle writes and terminal launches. They never start, stop or restart user containers.
- The actual component was instantiated with the installed Omarchy UI under Wayland; a confirmation was requested and canceled without writes. This does not replace visual or keyboard interaction testing.
- A release still requires manual visual/keyboard testing in a live Omarchy session. Passing static checks is not a security audit.

## 1.0.1

- Fix RAM byte overflow, daemon-memory detection and slider bounds.
- Fix queued memory previews and keyboard edits when selection changes.
- Display Docker update errors and protect interactions from model refreshes.
- Add regression CI and improve installation and safety documentation.
