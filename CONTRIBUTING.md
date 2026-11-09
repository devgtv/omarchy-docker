# Contributing to Omarchy Control Docker

Thanks for taking the time to improve `devgtv.docker`. This document explains
how to propose changes, what is expected from a pull request, and how review
and merging work.

## Scope

This repository contains a single Omarchy Shell (Quickshell) bar widget:

| Path | Purpose |
| --- | --- |
| `Panel.qml` | Bar widget, popup and keyboard/wheel interaction |
| `Model.js` | Docker snapshot collection, parsing and lifecycle commands |
| `manifest.json` | Plugin metadata and shell contract |
| `test/` | Node.js, Bash and graphical test suites |
| `README.md` | Behavior, installation, usage and safety notes |
| `CHANGELOG.md` | User-visible changes by release |

Keep changes focused on the plugin. Do not add unrelated tooling, vendored
dependencies or formatting-only churn.

## Before you start

- For small fixes (typos, docs, narrow bugs) just open the pull request.
- For behavior changes, new features or anything that touches container
  lifecycle, RAM limits, Docker contexts or log handling, open an issue first
  so the approach can be agreed on before you invest time.
- Security issues should not be reported in a public issue. Contact the
  maintainer privately first.

## Requirements

- Omarchy Quattro with Quickshell, for graphical checks.
- Bash and Node.js to run the test suites.
- Docker CLI with access to a daemon, for the integration portions.
- `xdg-terminal-exec` and a configured default terminal, for log tests.

You do not need root. Membership in the `docker` group grants effective
root-level access over the daemon, so treat any machine with that access as
sensitive.

## Workflow

1. Fork the repository and create a branch from `main`.
2. Make the change, keeping the existing QML/JavaScript style and structure.
3. Run the regression suite:

   ```bash
   bash test/run
   ```

   This suite is read-only against a live daemon and skips live Docker checks
   when no daemon is reachable.
4. Commit, push to your fork and open a pull request against `main`.

### Branch names

Use a short, descriptive name with a type prefix, for example:

```text
fix/ram-slider-bounds
feat/container-events
docs/contributing
test/log-terminal-errors
```

### Commit messages

Write an imperative subject line, 72 characters or less, optionally prefixed
with `fix:`, `feat:`, `docs:`, `test:` or `refactor:`:

```text
fix: reject malformed sizes in parseSizeToBytes
docs: document the pull request workflow
```

Keep each commit to one logical change. Pull requests are merged by their
title, so make the title describe the final result.

## Testing

Run the normal suite before opening a pull request:

```bash
bash test/run
```

Additional suites are available for changes that need them:

```bash
# Real Docker lifecycle and log commands on disposable, labeled containers.
# Opt-in: it creates, exercises and removes its own containers.
DOCKER_PLUGIN_DISPOSABLE_TESTS=1 node test/lifecycle.test.js

# Graphical panel suite on an active Omarchy Wayland session (requires QtTest).
DOCKER_PLUGIN_UI_OUTPUT="$(mktemp -d)" bash test/ui/run

# Real default-terminal behavior on Hyprland, including Ctrl+C and Enter.
DOCKER_PLUGIN_TERMINAL_TESTS=1 DOCKER_PLUGIN_UI_OUTPUT="$(mktemp -d)" \
  node test/terminal.test.js
```

Never opt into the write/lifecycle or terminal suites against a production
Docker endpoint or while using your main desktop session for other work. CI
runs the read-only regression suite and the disposable-container suite on a
dedicated Linux runner.

## Pull request guidelines

- Explain **what** changed and **why**. Link the related issue when there is
  one.
- Include reproduction steps or the failing case for bug fixes.
- Add or update tests for behavior changes. A fix without a regression test is
  likely to be asked for changes.
- Update `README.md` when user-facing behavior, configuration or installation
  changes, and add an entry to `CHANGELOG.md` for user-visible changes.
- Include a screenshot or short recording for visible UI changes.
- Keep the diff small. Separate refactors from behavior changes.
- Do not commit generated artifacts, editor files, secrets or real container
  logs.

## Review and merging

- Every change reaches `main` through a pull request. The `main` branch is
  protected: force pushes and deletions are blocked, required status checks
  must pass and conversations must be resolved.
- **Only the maintainer merges pull requests.** Review approval is required
  before a pull request can be merged, and the author cannot approve their own
  pull request.
- Contributors do not receive write access to this repository. Contribute from
  a fork; the maintainer reviews, approves and merges.
- Do not expect a specific timeline. Reviews are done on a best-effort basis.
- Push additional commits to your pull request branch to address feedback.
  Avoid force-pushing after review has started unless asked to.

## Security notes

- Logs, container environment variables and inspect output may contain
  secrets. Redact them before pasting into an issue or pull request.
- Docker daemon access is effectively root access. Do not run untrusted images
  or write-oriented test suites on machines you do not control.
- Lowering a container's memory limit can cause its workload to be killed by
  the kernel's out-of-memory handler. Mention this in proposals that change
  resource handling.

## License

By contributing you agree that your changes are licensed under the project's
MIT license.
