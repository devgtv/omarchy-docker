# Version 1.1.0 validation

Validated on 2026-11-09 against source commit
`ddbbadeca87b9e59438d36bca0ab1f9c14078925`. Later documentation-only commits do not
change that tested implementation. This records tested behavior, not a security
audit or a claim of compatibility with every Docker/desktop configuration.

## Results

| Check | Result |
| --- | --- |
| Model assertions | 108 passed |
| Mocked controller scenarios | 20 passed |
| Fake CLI snapshot scenarios | 3 passed |
| Installed Omarchy manifest/component contract | Passed locally |
| QML syntax (`qmllint Panel.qml`) | Passed locally |
| Real Docker integration on an isolated GitHub runner | 14 scenarios passed; both disposable containers removed |
| Actual Quickshell panel under Wayland | Passed with fake Docker/terminal backends |
| Actual default terminal launcher and Foot | Passed with fake Docker log output; both test windows closed |

Real Docker evidence:
[GitHub Actions run 42614826001](https://github.com/devgtv/omarchy-docker/actions/runs/42614826001).

## Coverage

- Created, running and exited containers; multi-container stats and independent
  full-ID targeting.
- Controller confirmation/cancel paths, real Start/Stop/Restart, increasing and
  decreasing RAM, and setting the first limit on an unlimited container.
- Real recent logs, timestamps, live streaming, SIGINT behavior and stopped logs.
- UI keyboard navigation, start/stop confirmations, default Cancel, Escape,
  Tab/arrows/Enter, blocked background shortcuts, RAM adjustment, restart and
  recent/live-log shortcuts, a mouse action button and outside dismissal.
- Synthetic permission-denied feedback without a false stopped state.
- Normal and narrow panel/confirmation screenshots, wrapped action buttons and
  automatic cursor scrolling across a ten-container list.
- Real terminal output retention after recent logs and after targeted Ctrl+C,
  followed by Enter-to-close. Only test terminal windows were addressed.

The local runtime environment was Quickshell 0.3.2
(`2b4501a282689792b62e94f3fb30d8f512324fe6`, Omarchy build) on Hyprland 0.56.2.
Existing GTK theme parsing and portal-registration warnings appeared during the
isolated test instance; the successful final UI runs had no plugin QML binding
errors. Screenshots remained local test artifacts, not repository assets.

## Issues found and fixed

1. Increasing RAM directly with unlimited swap was rejected by the runner's
   runtime. The controller now applies a finite valid RAM/memory+swap pair, then
   lifts the swap bound. Integration tests inspect the final RAM and `MemorySwap`
   settings. A second-stage failure explicitly reports the partial change.
2. Process completion continuations are deferred before launching another stage
   or refreshing, avoiding dependence on the exit signal's running-state order.
3. The actual default terminal launcher ignored `--hold`. A constant Bash wrapper
   now keeps output and exit status visible until Enter, including after Ctrl+C.
   Untrusted values are passed as quoted positional arguments, not interpolated
   into the shell program.

During test-harness development, re-entering a test timer across nested QtTest
waits crashed the separate test instance. The harness now starts only once and
defers shutdown; repeated final runs passed. This was not a crash of the user's
installed shell.

## Remaining limits

- The local Docker socket rejected this user's access, so real container writes
  ran on the disposable CI runner, not the user's machine. No group memberships,
  socket permissions, desktop configuration or installed plugin were changed.
- Real remote/rootless Docker endpoints, alternate terminal/compositor versions,
  multi-monitor dismissal and long-running production workloads were not tested.
  Target selection/override precedence is covered by fake-CLI and unit tests.
- The graphical suite and real Docker suite are separate: the former uses actual
  QML/Process/keyboard/pointer behavior with a fake CLI, while the latter executes
  controller-generated commands against a real daemon.

Reproduction commands and safety notes are documented in the root README and
[`manual.md`](manual.md).
