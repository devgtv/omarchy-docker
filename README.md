# Omarchy Control Docker

`devgtv.docker` — bar widget for the Omarchy Shell (Quickshell) that shows running Docker containers and lets you control the RAM limit of each one.

![preview](preview.png)

## What it does

- Adds a Docker icon to the bar.
- Click the icon to open a popup with the running containers and their resource usage.
- For each container you can see its status, CPU and used memory.
- A slider sets the RAM limit of the selected container (`docker update --memory ... --memory-swap -1`).
- The popup auto-refreshes every 3 seconds.

## Installation

Requires Omarchy Quattro (Quickshell), Bash, the Docker CLI and access to a running Docker daemon. Install and enable it with:

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
  - `Esc` close
- The slider range goes from 6 MiB up to the Docker daemon's total RAM, including remote contexts. Keyboard and wheel adjustments use 128 MiB steps. If RAM cannot be detected, only the 6 MiB minimum is available.
- Failed RAM updates show the Docker error in the popup. Rapid edits are queued per container, even if you change selection before the keyboard debounce finishes.
- Changing a limit also sets `--memory-swap -1` (unlimited swap, not disabled swap). Lowering memory can cause a container's workload to be killed by the kernel's out-of-memory handler. Changes affect the selected Docker context, which may be remote.

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
- The limit change uses `docker update --memory <MB>m --memory-swap -1 <container>`.
- The user needs access to the selected Docker daemon (for example via the `docker` group or rootless Docker). Membership in the `docker` group effectively grants root-level access; this plugin does not elevate privileges.

## Testing Model.js locally

Run the regression suite (Node.js and Bash; live Docker integration skips when no daemon is reachable):

```bash
bash test/run
```

You can also inspect a read-only snapshot with Node.js:

```bash
node -e '
const M = require("./Model.js");
console.log(M.snapshotScript);
console.log(M.parseSnapshot(require("child_process").execSync(M.snapshotScript, {encoding:"utf8"})));
'
```

## License

MIT
