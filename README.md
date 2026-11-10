# Omarchy Control Docker

`devgtv.docker` — bar widget for the Omarchy Shell (Quickshell) that lists Docker containers, controls their lifecycle and adjusts running containers' CPU and RAM limits.

![preview](preview.png)

## What it does

- Adds a Docker icon to the bar.
- Click the icon to open a popup with running and stopped containers. Resource stats and RAM sliders are shown for running containers.
- For each container you can see its status, CPU and used memory.
- Sliders set the RAM and CPU limits of running containers. Resource presets provide common starting points.
- The popup auto-refreshes every 3 seconds.
- The popup identifies the selected Docker context and whether it uses a local socket or a network endpoint. `DOCKER_CONTEXT` takes precedence over `DOCKER_HOST`, matching Docker CLI behavior.
- Snapshots and RAM updates explicitly select their captured target, so switching the default context does not redirect an already queued update. Host URLs are not displayed, to avoid exposing embedded credentials.
- Open the last 200 timestamped log lines in your default terminal, or follow live output. Multiple log terminals can be open independently without blocking the panel.
- Search by name, image, ID, state, health or Compose project/service. Search is case-insensitive and literal; multiple terms are combined with AND.
- Combine state/project filters and optionally group by Compose project. Standalone containers appear after Compose projects; these controls do not modify Docker state.
- Expand Details to view health, ports, mounts, uptime, Compose labels and Docker exit/OOM/error fields. A nonzero exit code alone does not identify why a container exited.
- Copy the container name, full ID or port mappings from Details. Clipboard support requires `wl-copy`; copy failures are reported.

## Installation

Requires Omarchy Quattro (Quickshell), Bash, GNU coreutils (`timeout` and `head`), the Docker CLI and access to a running Docker daemon. Log viewing additionally requires `xdg-terminal-exec` and a configured default terminal (provided by a standard Omarchy installation). Install and enable it with:

```bash
omarchy plugin install https://github.com/devgtv/omarchy-docker
omarchy plugin enable devgtv.docker right
```

The bar hot-reloads on save. To summon the popup from the keyboard you can bind the `devgtv.docker` IPC target to a Hyprland key.

## Removal

Disable the widget and remove the plugin checkout:

```bash
omarchy plugin disable devgtv.docker
omarchy plugin remove devgtv.docker
```

## Usage

- Click the Docker icon in the bar to open the popup.
- Click a container row to select it, or use the keyboard:
  - `j`/`k` move between containers
  - `h`/`l` adjust the RAM limit (300 ms debounce)
  - `r` force refresh
  - `s` request start/stop for the selected container
  - `Shift+r` request restart for the selected running container
  - `g` open recent logs for the selected container
  - `Shift+g` follow logs for the selected container
  - `/` focus search; Enter/Down returns to list navigation, Escape leaves the search field
  - `d` toggle details for the selected visible container
  - `Esc` close
- The slider range goes from 6 MiB up to the Docker daemon's total RAM, including remote contexts. Keyboard and wheel adjustments use 128 MiB steps. If RAM cannot be detected, only the 6 MiB minimum is available.
- RAM presets set 256 MiB, 512 MiB or 1 GiB. CPU can be adjusted from 0.1 cores to the daemon's logical CPU count, or set with 0.5/1/2-core presets. The Unlimited button sets the daemon's full logical CPU capacity; this is effectively uncapped beyond the host itself. Docker ignores a zero CPU update rather than clearing a prior quota, so the panel uses the daemon maximum instead. The reported CPU count also bounds the slider and disables presets above that capacity.
- Failed RAM updates show the Docker error in the popup. Rapid edits are queued per container, even if you change selection before the keyboard debounce finishes.
- Start is available for created/exited containers; stop and restart are available for running containers. Other states remain read-only. Every lifecycle action asks for confirmation, showing the container and Docker target. Cancel is selected by default; use arrows or Tab to select Confirm, then Enter. Escape cancels. Closing the panel also cancels an unconfirmed action.
- Lifecycle actions and RAM updates do not run concurrently. Commands use full container IDs, so replacing a container with another of the same name does not redirect an already captured action. Successful operations refresh the list; failures appear in the popup. Starting runs the container workload, and stopping/restarting may interrupt services.
- Logs are available for stopped containers too, subject to the Docker logging driver. The selected Docker target and full container ID are passed as quoted positional arguments to a constant Bash wrapper; no container name is interpolated into the shell program. Follow mode uses `docker logs --follow`; press Ctrl+C to stop following. After completion the exit status is shown and the terminal waits for Enter, including terminals whose desktop entries ignore `--hold`. Docker/logging-driver errors are displayed in that terminal; terminal-launch failures are logged by Quickshell. Logs may contain secrets: inspect them before sharing.
- Changing a limit also sets `--memory-swap -1` (unlimited swap, not disabled swap). Lowering memory can cause a container's workload to be killed by the kernel's out-of-memory handler. Changes affect the selected Docker context, which may be remote.
- CPU and RAM updates apply to the running container only. They do not edit Compose files and may be lost when Compose or another orchestrator recreates the container. The panel warns about this beside resource controls. CPU limits constrain available processing time; they do not reserve CPU cores. The Unlimited preset uses the daemon's total logical CPU count because Docker's update API treats a zero NanoCpus value as unchanged.
- Filters and grouping are session-local and combine with search. Stopped includes created/exited containers; paused, restarting, dead and removing have separate state filters. Reset filters clears search and filters, not the grouping preference.
- Keyboard selection follows the full container ID across reordering; if that ID is filtered out, selection is clamped. Empty result lists cannot trigger actions. Search text does not invoke lifecycle, RAM or log shortcuts.
- Detail metadata updates with snapshots. Published ports are distinguished from exposed-but-unpublished ports. Mount paths and runtime errors may expose sensitive information; inspect before sharing. Environment variables and healthcheck output are not collected.

## Configuration

In `~/.config/omarchy/shell.json`, the widget entry accepts a custom `refreshMs`:

```json
{
  "id": "devgtv.docker",
  "refreshMs": 5000
}
```

Default is 3000 ms.

## Implementation details

- Data is collected by a Quickshell `Process` running `docker ps`, `docker inspect` and `docker stats`.
- A snapshot has a 15-second total deadline and accepts at most 128 containers, 256 KiB of inspect output (16 KiB per row), and 32 KiB of stats. Other command outputs are also bounded. If a deadline or limit is exceeded, the previous snapshot remains visible with an error; the next refresh retries. These limits bound data retained by the plugin, not memory used internally by the Docker CLI when decoding daemon responses.
- A RAM limit change first applies `--memory <MB>m --memory-swap <2×MB>m`, then lifts the temporary swap bound with `--memory-swap -1`. Applying a finite valid pair first avoids runtime errors observed when increasing RAM directly to unlimited swap. If the second step fails, the RAM change and temporary combined memory+swap limit remain applied; the popup explicitly reports that partial change. CPU limits use Docker's `--cpus` setting. The Unlimited preset sets the value to the daemon's full logical CPU count because `--cpus 0` is ignored by Docker updates when a previous limit exists.
- The user needs access to the selected Docker daemon (for example via the `docker` group or rootless Docker). Membership in the `docker` group effectively grants root-level access; this plugin does not elevate privileges.

## Testing Model.js locally

Run the regression suite (Node.js and Bash; live Docker integration skips when no daemon is reachable):

```bash
bash test/run
```

CI additionally runs `node test/lifecycle.test.js` with
`DOCKER_PLUGIN_DISPOSABLE_TESTS=1` on its disposable Linux amd64 runner. This
explicitly opted-in suite pulls a digest-pinned BusyBox image, creates two labeled
containers without networking/host mounts, exercises the real controller's
Start/Stop/Restart/RAM commands and recent/live log commands, then removes only
its own containers. The normal `test/run` remains read-only against a live daemon.
Do not opt into write tests on production Docker endpoints.

For the opt-in graphical suite on an active Omarchy Wayland session (requires
QtTest), use a fresh artifact directory. It opens a temporary panel with fake
Docker data and a fake terminal launcher; it does not replace the installed
plugin or access a real daemon:

```bash
DOCKER_PLUGIN_UI_OUTPUT="$(mktemp -d)" bash test/ui/run
```

To test the real default terminal separately on Hyprland, including output
retention, targeted Ctrl+C and Enter, run:

```bash
DOCKER_PLUGIN_TERMINAL_TESTS=1 DOCKER_PLUGIN_UI_OUTPUT="$(mktemp -d)" node test/terminal.test.js
```

This opens two test terminals with fake Docker output and closes only those test
windows afterward. Neither local suite changes desktop configuration or uses
real container logs. Screenshots and runtime logs are saved in the artifact
directory. Do not interact with the test panel while the graphical suite runs.

You can also inspect a read-only snapshot with Node.js:

```bash
node -e '
const M = require("./Model.js");
console.log(M.snapshotScript);
console.log(M.parseSnapshot(require("child_process").execSync(M.snapshotScript, {encoding:"utf8"})));
'
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pull request workflow, testing
requirements and review policy. Only the maintainer merges pull requests.

## License

MIT
