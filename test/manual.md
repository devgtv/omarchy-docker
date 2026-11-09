# Manual pre-release checks

Use disposable development containers, never a production Docker context. Do not
run these actions on workloads that cannot tolerate interruption. Automated tests
mock lifecycle writes and terminal launches; they do not cover this checklist.

- Open the panel with both running and exited containers. Check textual states,
  running/total counts, scrolling, button wrapping and narrow-screen layout.
- Verify that only running containers show CPU/RAM controls. Exited/created
  containers offer Start; running containers offer Stop/Restart.
- Open each confirmation and verify the name and target. Enter initially cancels;
  arrows/Tab can select Confirm. Escape, outside dismissal and panel switching
  cancel without executing anything. Background shortcuts must not fire.
- On disposable containers, confirm Start/Stop/Restart. Check refresh and feedback.
  Revoke daemon access and verify a useful error instead of a success message.
- While a write is in flight, verify another lifecycle action cannot start and RAM
  writes cannot run concurrently with it.
- Open Logs and Follow logs for different containers. Check the last 200 lines,
  timestamps, terminal title/target, Ctrl+C and terminal retention after exit.
  Check logs for exited containers and logging-driver error output.
- Test `j/k`, `h/l`, `s`, `Shift+r`, `g`, `Shift+g`, `r` and Escape. Memory edits
  should retain their original container when the cursor moves.
- Switch between disposable local and remote contexts. Confirm the label changes
  on refresh and an already captured confirmation/log command retains its target.
- Check rootless Docker and `DOCKER_CONTEXT`/`DOCKER_HOST` overrides. Never share
  credentials or unredacted logs/screenshots from these checks.

Record the Omarchy/Quickshell versions and exact tested plugin commit when
reporting results. A smoke load or syntax check is not a full visual review.
