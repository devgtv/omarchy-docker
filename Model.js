// Docker plugin data logic: collection script + pure parsers.
// Kept separate from the UI so it can be tested with node (see README.md).

// Bash script run by the panel Process. Output is sectioned:
//   ==TARGET==     selector kind, selector value, daemon endpoint (one per line)
//   ==DOCKER==     daemon version or "unavailable"
//   ==HOST==       host total RAM in bytes; ==HOSTCPU== daemon logical CPU count
//   ==CONTAINERS== id|name|image|status|memLimitBytes|JSON metadata
//   ==STATS==      one line per container: name|cpuPerc|memUsage|memPerc
// Only the first five separators are structural. Metadata is JSON encoded,
// preserving pipes, newlines and Unicode in labels, paths and error messages.
// Project only the fields we display: never emit environment or health logs.
var inspectFormat = '{{.Id}}|{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{.HostConfig.Memory}}|{"health":{{with index .State "Health"}}{{json .Status}}{{else}}""{{end}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"ports":{{json .NetworkSettings.Ports}},"exposedPorts":{{json .Config.ExposedPorts}},"mounts":{{json .Mounts}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}},"exitCode":{{json .State.ExitCode}},"oomKilled":{{json .State.OOMKilled}},"error":{{json .State.Error}},"nanoCpus":{{json .HostConfig.NanoCpus}}}'
var snapshotScript = [
  // Each command is capped before command substitution can retain its output.
  // The outer timeout in Panel.qml bounds the entire process group.
  "export LC_ALL=C",
  "set -o pipefail",
  "bounded() { local max=$1 data; shift; data=$(\"$@\" 2>/dev/null | head -c $((max + 1))) || return 1; [ ${#data} -le \"$max\" ] || return 1; printf '%s\\n' \"$data\"; }",
  "kind=context",
  "target=${DOCKER_CONTEXT:-}",
  "if [ -z \"$target\" ] && [ -n \"${DOCKER_HOST:-}\" ]; then kind=host; target=$DOCKER_HOST; fi",
  "if [ -z \"$target\" ]; then target=$(bounded 1024 docker context show) || exit 1; fi",
  "[ ${#target} -le 1024 ] && [[ $target != *$'\\n'* && $target != *$'\\r'* ]] || exit 1",
  "endpoint=$target",
  "if [ \"$kind\" = context ]; then endpoint=$(bounded 1024 docker context inspect \"$target\" --format '{{.Endpoints.docker.Host}}') || exit 1; fi",
  "echo '==TARGET=='",
  "printf '%s\\n' \"$kind\" \"$target\" \"$endpoint\"",
  // Freeze the selected target for every command in this snapshot. Clearing
  // selector variables also makes explicit action commands independent of later
  // `docker context use` changes; TLS/auth configuration is otherwise preserved.
  "docker_cmd() { [ -n \"$target\" ] && env -u DOCKER_CONTEXT -u DOCKER_HOST docker --\"$kind\" \"$target\" \"$@\"; }",
  "echo '==DOCKER=='",
  "version=$(bounded 1024 docker_cmd version --format '{{.Server.Version}}') || exit 1",
  "printf '%s\\n' \"$version\"",
  "echo '==HOST=='",
  "mem=$(bounded 128 docker_cmd info --format '{{.MemTotal}}') || exit 1",
  "echo \"${mem:-0}\"",
  "echo '==HOSTCPU=='",
  "cpu=$(bounded 128 docker_cmd info --format '{{.NCPU}}') || exit 1",
  "echo \"${cpu:-0}\"",
  "echo '==CONTAINERS=='",
  "ids=$(bounded 8320 docker_cmd ps -aq) || exit 1",
  "count=0",
  "while IFS= read -r id; do",
  "  [ -z \"$id\" ] && continue",
  "  [[ $id =~ ^[a-zA-Z0-9]{1,64}$ ]] || exit 1",
  "  count=$((count + 1)); [ \"$count\" -le 128 ] || exit 1",
  "done <<< \"$ids\"",
  "rows=",
  "if [ -n \"$ids\" ]; then",
  "  rows=$(bounded 262144 docker_cmd inspect --format '" + inspectFormat + "' $ids) || exit 1",
  "  row_count=0",
  "  while IFS= read -r row; do",
  "    row_count=$((row_count + 1)); [ \"$row_count\" -le 128 ] && [ ${#row} -le 16384 ] || exit 1",
  "    IFS='|' read -r rid name image status memory rest <<< \"$row\"",
  "    [[ $rid =~ ^[a-zA-Z0-9]{1,64}$ ]] && [ ${#name} -le 4096 ] && [ ${#image} -le 4096 ] && [ ${#status} -le 128 ] || exit 1",
  "  done <<< \"$rows\"",
  "  printf '%s\\n' \"$rows\"",
  "fi",
  "echo '==STATS=='",
  "running_ids=",
  "while IFS='|' read -r id name image status memory; do",
  "  if [ \"$status\" = running ]; then running_ids=\"$running_ids $id\"; fi",
  "done <<< \"$rows\"",
  "if [ -n \"$running_ids\" ]; then",
  "  bounded 32768 docker_cmd stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}' $running_ids || exit 1",
  "fi",
  "echo '==COMPLETE=='"
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

function validContainer(container) {
  return !!container && /^[a-f0-9]{64}$/.test(String(container.fullId || ""))
}

function canContainerAction(action, container) {
  if (!validContainer(container)) return false
  if (action === "start") return container.status === "created" || container.status === "exited"
  return (action === "stop" || action === "restart") && container.status === "running"
}

function containerActionCommand(target, action, container) {
  if (!canContainerAction(action, container)) return []
  return dockerCommand(target, [action, "--", container.fullId])
}

function logsCommand(target, container, follow) {
  if (!validContainer(container) || !validTarget(target)) return []
  var args = ["logs", "--tail", "200", "--timestamps"]
  if (follow === true) args.push("--follow")
  args.push("--", container.fullId)
  // Some terminal desktop entries silently ignore --hold. Use a constant Bash
  // program with positional arguments instead, never interpolating Docker data.
  // Trap SIGINT in the wrapper so Ctrl+C stops following but retains the output.
  var keepOpen = "trap ':' INT; \"$@\"; status=$?; printf '\\nDocker logs finished (exit %s). Press Enter to close.\\n' \"$status\"; read -r _; exit \"$status\""
  return ["xdg-terminal-exec", "--title=Docker logs: " + String(container.name || container.fullId.substring(0, 12)) + " · " + targetLabel(target), "--", "bash", "-c", keepOpen, "docker-plugin-logs"].concat(dockerCommand(target, args))
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

function clampCpuCores(cores, maxCores) {
  var n = Math.round(Number(cores) * 10) / 10
  var max = Math.floor(Number(maxCores) * 10) / 10
  if (!isFinite(n)) n = 0.1
  if (!isFinite(max) || max < 0.1) max = 0.1
  return Math.max(0.1, Math.min(max, n))
}

// Use the daemon's RAM (also correct for remote Docker contexts). Unknown RAM
// leaves only the minimum available; never invent a 16 GiB host capacity.
function hostMemoryMb(bytes) {
  var n = Number(bytes)
  return isFinite(n) && n > 0 ? Math.max(6, Math.floor(n / 1048576)) : 6
}

function metadata(text) {
  var data = {}
  try { data = JSON.parse(text) || {} } catch (error) { /* older snapshots */ }
  function string(value) { return typeof value === "string" ? value : "" }
  function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {} }
  function mergedPorts(ports, exposedPorts) {
    var result = {}
    ports = object(ports)
    exposedPorts = object(exposedPorts)
    Object.keys(ports).forEach(function(port) { result[port] = ports[port] })
    // Some Docker targets report only Config.ExposedPorts when no host port is
    // published yet; keep those as explicit "not published" entries.
    Object.keys(exposedPorts).forEach(function(port) {
      if (!Object.prototype.hasOwnProperty.call(result, port)) result[port] = null
    })
    return result
  }
  return {
    health: ["healthy", "unhealthy", "starting"].indexOf(data.health) >= 0 ? data.health : "",
    project: string(data.project), service: string(data.service),
    ports: mergedPorts(data.ports, data.exposedPorts),
    mounts: Array.isArray(data.mounts) ? data.mounts.filter(function(m) { return m && typeof m === "object" }) : [],
    startedAt: string(data.startedAt), finishedAt: string(data.finishedAt),
    exitCode: typeof data.exitCode === "number" && isFinite(data.exitCode) ? data.exitCode : null,
    oomKilled: data.oomKilled === true, error: string(data.error),
    nanoCpus: typeof data.nanoCpus === "number" && isFinite(data.nanoCpus) && data.nanoCpus >= 0 ? data.nanoCpus : 0
  }
}

// Keep filtering/grouping purely presentational: no hidden Docker operations.
function visibleContainers(containers, query, state, project, grouped) {
  var terms = String(query || "").trim().toLowerCase().split(/\s+/).filter(function(t) { return t !== "" })
  var result = containers.filter(function(c) {
    if (state && state !== "all" && (state === "stopped" ? ["created", "exited"].indexOf(c.status) < 0 : c.status !== state)) return false
    if (project && c.project !== project) return false
    var text = [c.name, c.image, c.status, c.project, c.service, c.health, c.fullId].join(" ").toLowerCase()
    return terms.every(function(term) { return text.indexOf(term) >= 0 })
  })
  if (grouped) result.sort(function(a, b) {
    var ap = a.project || "", bp = b.project || ""
    if (ap !== bp) return ap === "" ? 1 : bp === "" ? -1 : ap < bp ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return result
}

function projects(containers) {
  return containers.map(function(c) { return c.project || "" }).filter(function(p, i, list) { return p !== "" && list.indexOf(p) === i }).sort()
}

function selectionIndex(previous, next, index) {
  var id = previous[index] ? previous[index].fullId : ""
  for (var i = 0; i < next.length; i++) if (next[i].fullId === id) return i
  return Math.max(0, Math.min(index, next.length - 1))
}

function portsText(container) {
  var ports = container.ports || {}
  return Object.keys(ports).sort().map(function(port) {
    var bindings = ports[port]
    // QML may expose nested arrays as QVariantList sequences, for which
    // Array.isArray is false even though list iteration is supported.
    if (!bindings || typeof bindings !== "object" || typeof bindings.length !== "number" || bindings.length === 0) return port + " (not published)"
    return bindings.filter(function(b) { return b && typeof b === "object" }).map(function(b) {
      var host = String(b.HostIp || "0.0.0.0")
      if (host.indexOf(":") >= 0) host = "[" + host + "]"
      return host + ":" + String(b.HostPort || "?") + " → " + port
    }).join("\n")
  }).join("\n")
}

function uptimeText(container, now) {
  var start = Date.parse(container.startedAt || "")
  var elapsed = Math.floor((now - start) / 1000)
  if (container.status !== "running" || !isFinite(elapsed) || elapsed < 0 || start <= 0) return "Unavailable"
  if (elapsed < 60) return elapsed + "s"
  if (elapsed < 3600) return Math.floor(elapsed / 60) + "m"
  if (elapsed < 86400) return Math.floor(elapsed / 3600) + "h " + Math.floor(elapsed % 3600 / 60) + "m"
  return Math.floor(elapsed / 86400) + "d " + Math.floor(elapsed % 86400 / 3600) + "h"
}

function detailsText(c, now) {
  var mounts = (c.mounts || []).map(function(m) {
    return String(m.Type || "mount") + ": " + String(m.Name || m.Source || "") + " → " + String(m.Destination || "") + (m.RW === false ? " (read-only)" : "")
  }).join("\n")
  var exit = c.exitCode === null || c.exitCode === undefined ? "Unknown" : String(c.exitCode)
  return "Image: " + c.image + "\nID: " + c.fullId
    + "\nCompose project: " + (c.project || "None") + "\nCompose service: " + (c.service || "None")
    + "\nHealth: " + (c.health || "No healthcheck") + "\nUptime: " + uptimeText(c, now)
    + "\nStarted: " + (c.startedAt || "Unavailable") + "\nFinished: " + (c.finishedAt || "Unavailable")
    + "\nLast exit code: " + exit + (c.oomKilled ? " (OOM killed)" : "")
    + "\nRuntime error: " + (c.error || "None reported")
    + "\nPorts:\n" + (portsText(c) || "None") + "\nMounts:\n" + (mounts || "None")
}

function clipboardCommand(text) {
  // Constant program; data is a positional argument, never shell source.
  return ["bash", "-o", "pipefail", "-c", 'printf "%s" "$1" | wl-copy', "docker-plugin-copy", String(text)]
}

function parseSnapshot(text) {
  var result = {
    dockerAvailable: false,
    dockerVersion: "",
    target: null,
    hostMemBytes: 0,
    hostCpuCount: 0,
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

  var hostCpu = Number(String((sections["HOSTCPU"] || [])[0] || "").trim())
  result.hostCpuCount = isFinite(hostCpu) && hostCpu > 0 ? Math.floor(hostCpu) : 0

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
    var extra = metadata(cp.slice(5).join("|"))
    result.containers.push(Object.assign(extra, {
      id: String(cp[0] || "").trim().substring(0, 12),
      fullId: String(cp[0] || "").trim(),
      name: name,
      image: String(cp[2] || "").trim(),
      status: String(cp[3] || "").trim(),
      memLimitBytes: isFinite(limit) ? limit : 0,
      cpuLimit: isFinite(extra.nanoCpus) ? extra.nanoCpus / 1000000000 : 0,
      cpuPercent: stats ? stats.cpuPercent : "",
      memUsageBytes: stats ? stats.memUsageBytes : 0,
      memPercent: stats ? stats.memPercent : ""
    }))
  }

  return result
}

if (typeof module !== "undefined") {
  module.exports = {
    snapshotScript: snapshotScript,
    inspectFormat: inspectFormat,
    visibleContainers: visibleContainers,
    projects: projects,
    selectionIndex: selectionIndex,
    portsText: portsText,
    uptimeText: uptimeText,
    detailsText: detailsText,
    clipboardCommand: clipboardCommand,
    validTarget: validTarget,
    dockerCommand: dockerCommand,
    targetLabel: targetLabel,
    validContainer: validContainer,
    canContainerAction: canContainerAction,
    containerActionCommand: containerActionCommand,
    logsCommand: logsCommand,
    parseSizeToBytes: parseSizeToBytes,
    formatBytes: formatBytes,
    formatMb: formatMb,
    clampMemMb: clampMemMb,
    clampCpuCores: clampCpuCores,
    hostMemoryMb: hostMemoryMb,
    parseSnapshot: parseSnapshot
  }
}
