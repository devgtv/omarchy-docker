// Docker plugin data logic: collection script + pure parsers.
// Kept separate from the UI so it can be tested with node (see README.md).

// Bash script run by the panel Process. Output is sectioned:
//   ==TARGET==     selector kind, selector value, daemon endpoint (one per line)
//   ==DOCKER==     daemon version or "unavailable"
//   ==HOST==       host total RAM in bytes
//   ==CONTAINERS== one line per container: id|name|image|status|memLimitBytes
//   ==STATS==      one line per container: name|cpuPerc|memUsage|memPerc
// "|" is a safe separator: container/image names cannot contain "|".
var snapshotScript = [
  "kind=context",
  "target=${DOCKER_CONTEXT:-}",
  "if [ -z \"$target\" ] && [ -n \"${DOCKER_HOST:-}\" ]; then kind=host; target=$DOCKER_HOST; fi",
  "if [ -z \"$target\" ]; then target=$(docker context show 2>/dev/null); fi",
  "endpoint=$target",
  "if [ \"$kind\" = context ]; then endpoint=$(docker context inspect \"$target\" --format '{{.Endpoints.docker.Host}}' 2>/dev/null); fi",
  "echo '==TARGET=='",
  "printf '%s\\n' \"$kind\" \"$target\" \"$endpoint\"",
  // Freeze the selected target for every command in this snapshot. Clearing
  // selector variables also makes explicit action commands independent of later
  // `docker context use` changes; TLS/auth configuration is otherwise preserved.
  "docker_cmd() { [ -n \"$target\" ] && env -u DOCKER_CONTEXT -u DOCKER_HOST docker --\"$kind\" \"$target\" \"$@\"; }",
  "echo '==DOCKER=='",
  "docker_cmd version --format '{{.Server.Version}}' 2>/dev/null || echo unavailable",
  "echo '==HOST=='",
  "mem=$(docker_cmd info --format '{{.MemTotal}}' 2>/dev/null)",
  "echo \"${mem:-0}\"",
  "echo '==CONTAINERS=='",
  "ids=$(docker_cmd ps -q 2>/dev/null)",
  "if [ -n \"$ids\" ]; then",
  "  docker_cmd inspect --format '{{.Id}}|{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{.HostConfig.Memory}}' $ids 2>/dev/null",
  "fi",
  "echo '==STATS=='",
  "if [ -n \"$ids\" ]; then",
  "  docker_cmd stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}' $ids 2>/dev/null",
  "fi"
].join("\n")

function validTarget(target) {
  return !!target && (target.kind === "context" || target.kind === "host")
    && typeof target.value === "string" && target.value.length > 0
    && !/[\x00-\x1f\x7f]/.test(target.value)
}

// Argument arrays only: never interpolate context names or daemon hosts into a
// shell command. Return no command if target detection failed (fail closed).
function dockerCommand(target, args) {
  if (!validTarget(target)) return []
  return ["env", "-u", "DOCKER_CONTEXT", "-u", "DOCKER_HOST", "docker", "--" + target.kind, target.value].concat(args)
}

function targetLabel(target) {
  if (!validTarget(target)) return "Docker target unavailable"
  var endpoint = String(target.endpoint || "")
  var location = /^(unix|npipe):/.test(endpoint) ? "local socket" : "remote / network"
  // Do not expose credentials embedded in a DOCKER_HOST URL.
  return (target.kind === "context" ? "Context: " + target.value : "DOCKER_HOST override") + " · " + location
}

function parseSizeToBytes(text) {
  var m = /^(\d+(?:\.\d+)?)\s*([KMGT]?i?B)$/i.exec(String(text || "").trim())
  if (!m) return 0
  var value = parseFloat(m[1])
  if (!isFinite(value)) return 0
  var unit = m[2].toUpperCase()
  var mult = 1
  if (unit === "KB") mult = 1000
  else if (unit === "KIB") mult = 1024
  else if (unit === "MB") mult = 1000 * 1000
  else if (unit === "MIB") mult = 1024 * 1024
  else if (unit === "GB") mult = 1000 * 1000 * 1000
  else if (unit === "GIB") mult = 1024 * 1024 * 1024
  else if (unit === "TB") mult = 1000 * 1000 * 1000 * 1000
  else if (unit === "TIB") mult = 1024 * 1024 * 1024 * 1024
  return Math.round(value * mult)
}

function formatBytes(bytes) {
  var n = Number(bytes)
  if (!isFinite(n) || n < 0) n = 0
  if (n >= 1099511627776) return (Math.round(n / 1099511627776 * 10) / 10) + " TiB"
  if (n >= 1073741824) return (Math.round(n / 1073741824 * 10) / 10) + " GiB"
  if (n >= 1048576) return (Math.round(n / 1048576 * 10) / 10) + " MiB"
  if (n >= 1024) return (Math.round(n / 1024 * 10) / 10) + " KiB"
  return Math.round(n) + " B"
}

function formatMb(mb) {
  var n = Number(mb)
  if (!isFinite(n) || n < 0) n = 0
  if (n >= 1024) return (Math.round(n / 1024 * 10) / 10) + " GiB"
  return Math.round(n) + " MiB"
}

function clampMemMb(mb, maxMb) {
  var n = Math.round(Number(mb))
  var max = Math.round(Number(maxMb))
  if (!isFinite(n)) n = 6
  if (!isFinite(max) || max < 6) max = 6
  return Math.max(6, Math.min(max, n))
}

// Use the daemon's RAM (also correct for remote Docker contexts). Unknown RAM
// leaves only the minimum available; never invent a 16 GiB host capacity.
function hostMemoryMb(bytes) {
  var n = Number(bytes)
  return isFinite(n) && n > 0 ? Math.max(6, Math.floor(n / 1048576)) : 6
}

function parseSnapshot(text) {
  var result = {
    dockerAvailable: false,
    dockerVersion: "",
    target: null,
    hostMemBytes: 0,
    containers: []
  }

  var sections = {}
  var current = ""
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var header = /^==(.+)==$/.exec(line.trim())
    if (header) {
      current = header[1]
      sections[current] = []
    } else if (current !== "") {
      sections[current].push(line)
    }
  }

  var dockerLines = sections["DOCKER"] || []
  var version = String(dockerLines[0] || "").trim()
  result.dockerAvailable = version !== "" && version !== "unavailable"
  result.dockerVersion = result.dockerAvailable ? version : ""

  var targetLines = sections["TARGET"] || []
  var target = { kind: String(targetLines[0] || "").trim(), value: String(targetLines[1] || "").trim(), endpoint: String(targetLines[2] || "").trim() }
  result.target = validTarget(target) ? target : null

  var hostLines = sections["HOST"] || []
  var hostBytes = Number(String(hostLines[0] || "").trim())
  result.hostMemBytes = isFinite(hostBytes) && hostBytes > 0 ? hostBytes : 0

  // Stats index by container name.
  var statsByName = {}
  var statsLines = sections["STATS"] || []
  for (var s = 0; s < statsLines.length; s++) {
    var sp = statsLines[s].split("|")
    if (sp.length < 4 || sp[0].trim() === "") continue
    var usageParts = sp[2].split("/")
    statsByName[sp[0].trim()] = {
      cpuPercent: String(sp[1] || "").trim(),
      memUsageBytes: parseSizeToBytes(usageParts[0] || ""),
      memPercent: String(sp[3] || "").trim()
    }
  }

  var containerLines = sections["CONTAINERS"] || []
  for (var c = 0; c < containerLines.length; c++) {
    var cp = containerLines[c].split("|")
    if (cp.length < 5 || cp[0].trim() === "") continue
    var name = String(cp[1] || "").trim().replace(/^\//, "")
    var limit = parseInt(String(cp[4] || "").trim(), 10)
    var stats = statsByName[name] || null
    result.containers.push({
      id: String(cp[0] || "").trim().substring(0, 12),
      name: name,
      image: String(cp[2] || "").trim(),
      status: String(cp[3] || "").trim(),
      memLimitBytes: isFinite(limit) ? limit : 0,
      cpuPercent: stats ? stats.cpuPercent : "",
      memUsageBytes: stats ? stats.memUsageBytes : 0,
      memPercent: stats ? stats.memPercent : ""
    })
  }

  return result
}

if (typeof module !== "undefined") {
  module.exports = {
    snapshotScript: snapshotScript,
    validTarget: validTarget,
    dockerCommand: dockerCommand,
    targetLabel: targetLabel,
    parseSizeToBytes: parseSizeToBytes,
    formatBytes: formatBytes,
    formatMb: formatMb,
    clampMemMb: clampMemMb,
    hostMemoryMb: hostMemoryMb,
    parseSnapshot: parseSnapshot
  }
}
