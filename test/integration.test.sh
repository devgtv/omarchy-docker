#!/bin/bash
#
# Integration test: runs the plugin's snapshot script against a real Docker
# daemon and validates the parsed shape. Skipped (ok - skip) when no daemon
# is reachable.

set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

if ! command -v docker >/dev/null 2>&1; then
  echo "ok - no docker CLI; skipping integration test"
  exit 0
fi

if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "ok - no reachable docker daemon; skipping integration test"
  exit 0
fi

SCRIPT=$(node -e 'const M = require(process.argv[1]); console.log(M.snapshotScript)' "$ROOT/Model.js")
SNAPSHOT=$(bash -c "$SCRIPT" 2>/dev/null || true)

if [[ -z $SNAPSHOT ]]; then
  echo "not ok - snapshot script produced no output" >&2
  exit 1
fi

node -e '
  const Model = require(process.argv[1])
  const snap = Model.parseSnapshot(process.argv[2])
  const fail = (m) => { console.error("not ok - " + m); process.exit(1) }
  const ok = (m) => console.log("ok - " + m)

  if (!snap.dockerAvailable) fail("snapshot parser disagrees with daemon reachability")
  ok("daemon reachable and parsed")

  if (!(snap.hostMemBytes > 0)) fail("host RAM parsed as " + snap.hostMemBytes)
  ok("host RAM parsed (" + snap.hostMemBytes + " bytes)")

  for (const c of snap.containers) {
    if (!c.id || !c.name || !c.image) fail("container missing id/name/image: " + JSON.stringify(c))
    if (c.memLimitBytes < 0) fail("container has negative limit: " + c.name)
  }
  ok("all " + snap.containers.length + " container rows well-formed")
' "$ROOT/Model.js" "$SNAPSHOT"

echo "ok - integration test passed"