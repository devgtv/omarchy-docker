#!/bin/bash
#
# Manifest and shell-contract test: validates manifest.json fields, runs
# omarchy-plugin-validate when available, and checks that every QML component
# referenced by Panel.qml exists in the Omarchy shell source (when the fork
# checkout is present).

set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
PLUGIN_DIR="$ROOT"
MANIFEST="$ROOT/manifest.json"

fail=0

check() {
  local condition="$1"
  local description="$2"
  if [[ $condition ]]; then
    echo "ok - $description"
  else
    echo "not ok - $description" >&2
    fail=1
  fi
}

[[ -f $MANIFEST ]]
check "$?" "manifest.json exists"

node -e '
  const fs = require("fs")
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  const fail = (msg) => { console.error("not ok - " + msg); process.exit(1) }
  const ok = (msg) => console.log("ok - " + msg)

  if (m.schemaVersion !== 1) fail("schemaVersion must be 1")
  ok("schemaVersion is 1")

  for (const field of ["id", "name", "version", "author", "license", "description"]) {
    if (typeof m[field] !== "string" || m[field].length === 0) fail("missing manifest field: " + field)
  }
  ok("required string fields present")

  if (!Array.isArray(m.kinds) || m.kinds.length === 0) fail("kinds must be a non-empty array")
  if (m.kinds.indexOf("bar-widget") < 0) fail("kinds must include bar-widget")
  ok("kinds include bar-widget")

  if (!m.entryPoints || typeof m.entryPoints.barWidget !== "string") fail("entryPoints.barWidget missing")
  const entry = m.entryPoints.barWidget
  if (!fs.existsSync(process.argv[2] + "/" + entry)) fail("entry point file missing: " + entry)
  ok("entry point file exists: " + entry)

  if (!m.barWidget || typeof m.barWidget.displayName !== "string" || m.barWidget.displayName.length === 0)
    fail("barWidget metadata incomplete")
  ok("barWidget metadata present")
' "$MANIFEST" "$PLUGIN_DIR"
[[ $? -eq 0 ]] || fail=1

if command -v omarchy-plugin-validate >/dev/null 2>&1; then
  if omarchy-plugin-validate "$PLUGIN_DIR" >/dev/null 2>&1; then
    echo "ok - omarchy-plugin-validate passes"
  else
    echo "not ok - omarchy-plugin-validate rejects the plugin" >&2
    fail=1
  fi
else
  echo "ok - omarchy-plugin-validate not installed; skipping"
fi

# Static contract check against the Omarchy shell source.
SHELL_DIR=""
for candidate in "$ROOT/../omarchy-fork/shell" /usr/share/omarchy/shell "$OMARCHY_PATH/shell"; do
  if [[ -d $candidate ]]; then
    SHELL_DIR=$candidate
    break
  fi
done

if [[ -z $SHELL_DIR ]]; then
  echo "ok - omarchy shell source not found; skipping QML contract check"
else
  for component in Panel KeyboardPanel PanelKeyCatcher PanelSlider PanelSeparator CursorSurface BarIconButton; do
    if [[ -f $SHELL_DIR/Ui/$component.qml ]]; then
      echo "ok - shell provides Ui/$component.qml"
    else
      echo "not ok - shell does not provide Ui/$component.qml" >&2
      fail=1
    fi
  done
fi

exit $fail