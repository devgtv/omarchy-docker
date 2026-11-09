# Changelog

## 1.2.0 (unreleased)

### Added

- Case-insensitive, literal multi-term search across container name, image, ID, state, health and Compose project/service.
- Combined state and Compose project filters, visible-result counts and a reset action.
- Optional Compose grouping with a separate standalone section.
- Healthcheck states and expandable details for image, full ID, Compose labels, uptime, ports, mounts and last exit diagnostics.
- Copy the container name, full ID or port information using `wl-copy`.
- `/` focuses search; `d` toggles details. Search input suppresses background shortcuts.

### Changed

- Collect JSON-encoded detail metadata in the existing inspect call, without collecting environment variables or healthcheck output.
- Preserve keyboard selection by full container ID when filters, grouping or snapshots reorder rows.
- Add discovery model, controller, UI and disposable real-Docker regression coverage.

## 1.1.0 (2026-11-09)

### Added

- Effective Docker context/host-override information with local-socket or network labeling.
- Stopped containers in the list, textual states and running/total counts.
- Start, Stop and Restart controls with per-container/per-target confirmation. Cancel is selected by default, and closing the panel cancels an unconfirmed action.
- Keyboard shortcuts: `s` for start/stop, `Shift+r` for restart, `g` for recent logs and `Shift+g` for live logs.
- Default-terminal log viewing with the last 200 timestamped lines, optional following and independent terminal windows.
- Fake Docker CLI collector tests and controller regressions for the new operations.
- Opt-in real-Docker integration tests using digest-pinned, labeled disposable containers, plus local graphical and default-terminal test suites.

### Changed

- Snapshots and operations explicitly select the captured context or host override instead of relying on the mutable default context.
- Lifecycle and RAM operations use full container IDs and do not run concurrently.
- Stats are collected only for running IDs from the inspected snapshot; stopped containers have no RAM controls.
- Snapshots started before a write are discarded and refreshed.
- Lifecycle progress, success and failure feedback is shown in the panel.
- Qualify the theme color singleton to avoid a QML color-name collision observed during runtime smoke testing.
- Apply a finite valid RAM/memory+swap pair before enabling unlimited swap, fixing runtime errors reproduced with real Docker. Partial updates are explicitly reported if the second stage fails.
- Defer process-exit continuations to the next event-loop turn before starting another command or refreshing the model.
- Retain completed log output with a constant Bash wrapper and an Enter-to-close prompt, even when the default terminal launcher ignores `--hold`.

### Validation notes

- The normal regression suite remains read-only against a live daemon; the separate CI write suite mutates only its own disposable containers and verifies cleanup.
- Local graphical tests exercise the actual Omarchy UI under Wayland with fake Docker data; terminal tests exercise the actual default terminal with fake output. These do not modify user desktop configuration or workloads.
- Real remote/rootless Docker endpoints and alternative terminal/compositor versions remain outside the validated environment. Passing these tests is not a security audit.

## 1.0.1

- Fix RAM byte overflow, daemon-memory detection and slider bounds.
- Fix queued memory previews and keyboard edits when selection changes.
- Display Docker update errors and protect interactions from model refreshes.
- Add regression CI and improve installation and safety documentation.
