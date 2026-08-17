// Docker plugin data logic: collection script + pure parsers.
// Kept separate from the UI so it can be tested with node (see README.md).

// Bash script run by the panel Process. Output is sectioned:
//   ==DOCKER==     daemon version or "unavailable"
//   ==HOST==       host total RAM in bytes
//   ==CONTAINERS== one line per container: id|name|image|status|memLimitBytes
//   ==STATS==      one line per container: name|cpuPerc|memUsage|memPerc
// "|" is a safe separator: container/image names cannot contain "|".
var snapshotScript = [
  "echo '==DOCKER=='",
  "docker version --format '{{.Server.Version}}' 2>/dev/null || echo unavailable",
  "echo '==HOST=='",
  "awk '/MemTotal/{print $2 * 1024}' /proc/meminfo",
  "echo '==CONTAINERS=='",
  "ids=$(docker ps -q 2>/dev/null)",
  "if [ -n \"$ids\" ]; then",
  "  docker inspect --format '{{.Id}}|{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{.HostConfig.Memory}}' $ids 2>/dev/null",
  "fi",
  "echo '==STATS=='",
  "if [ -n \"$ids\" ]; then",
  "  docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}' 2>/dev/null",
  "fi"
].join("\n")

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
  if (!isFinite(n)) n = 128
  if (!isFinite(max) || max < 128) max = 128
  return Math.max(128, Math.min(max, n))
}

function parseSnapshot(text) {
  var result = {
    dockerAvailable: false,
    dockerVersion: "",
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

  var hostLines = sections["HOST"] || []
  var hostBytes = parseInt(String(hostLines[0] || "").trim(), 10)
  result.hostMemBytes = isFinite(hostBytes) ? hostBytes : 0

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
    parseSizeToBytes: parseSizeToBytes,
    formatBytes: formatBytes,
    formatMb: formatMb,
    clampMemMb: clampMemMb,
    parseSnapshot: parseSnapshot
  }
}
