// Unit tests for Model.js pure functions. Run with node (TAP-style output).
// Loaded by test/run; can also be run directly: node test/model.test.js

const path = require("path")
const Model = require(path.join(__dirname, "..", "Model.js"))

let failures = 0
let passes = 0

function fail(description, detail) {
  failures += 1
  console.error(`not ok - ${description}`)
  if (detail !== undefined) console.error(`  ${detail}`)
}

function pass(description) {
  passes += 1
  console.log(`ok - ${description}`)
}

function assert(condition, description, detail) {
  if (condition) pass(description)
  else fail(description, detail)
}

function assertEqual(actual, expected, description) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  assert(a === e, description, `expected: ${e}\nactual:   ${a}`)
}

// ---------------------------------------------------------------------------
// parseSizeToBytes
// ---------------------------------------------------------------------------

assertEqual(Model.parseSizeToBytes("512MiB"), 512 * 1024 * 1024, "parseSizeToBytes parses MiB")
assertEqual(Model.parseSizeToBytes("1.5gib"), 1.5 * 1024 * 1024 * 1024, "parseSizeToBytes parses lowercase GiB")
assertEqual(Model.parseSizeToBytes("12.5 kB"), 12500, "parseSizeToBytes parses decimal kB")
assertEqual(Model.parseSizeToBytes("2GB"), 2 * 1000 * 1000 * 1000, "parseSizeToBytes parses GB")
assertEqual(Model.parseSizeToBytes("0.5KiB"), 512, "parseSizeToBytes parses fractional KiB")
assertEqual(Model.parseSizeToBytes("1.2.3GiB"), 0, "parseSizeToBytes rejects malformed numbers")
assertEqual(Model.parseSizeToBytes("12..5MiB"), 0, "parseSizeToBytes rejects double dots")
assertEqual(Model.parseSizeToBytes("12345"), 0, "parseSizeToBytes rejects bare numbers without a unit")
assertEqual(Model.parseSizeToBytes("abc"), 0, "parseSizeToBytes rejects garbage")
assertEqual(Model.parseSizeToBytes(""), 0, "parseSizeToBytes rejects empty string")
assertEqual(Model.parseSizeToBytes(null), 0, "parseSizeToBytes rejects null")
assertEqual(Model.parseSizeToBytes("  512 MiB  "), 512 * 1024 * 1024, "parseSizeToBytes trims surrounding whitespace")

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

assertEqual(Model.formatBytes(0), "0 B", "formatBytes formats zero")
assertEqual(Model.formatBytes(1023), "1023 B", "formatBytes stays in bytes below 1 KiB")
assertEqual(Model.formatBytes(1024), "1 KiB", "formatBytes formats KiB boundary")
assertEqual(Model.formatBytes(5 * 1024 * 1024), "5 MiB", "formatBytes formats MiB")
assertEqual(Model.formatBytes(1.5 * 1024 * 1024 * 1024), "1.5 GiB", "formatBytes formats GiB")
assertEqual(Model.formatBytes(1.5 * 1024 * 1024 * 1024 * 1024), "1.5 TiB", "formatBytes formats TiB")
assertEqual(Model.formatBytes(-5), "0 B", "formatBytes clamps negatives")
assertEqual(Model.formatBytes(NaN), "0 B", "formatBytes clamps NaN")
assertEqual(Model.formatBytes(Infinity), "0 B", "formatBytes clamps Infinity")

// ---------------------------------------------------------------------------
// formatMb
// ---------------------------------------------------------------------------

assertEqual(Model.formatMb(0), "0 MiB", "formatMb formats zero")
assertEqual(Model.formatMb(512), "512 MiB", "formatMb formats plain MiB")
assertEqual(Model.formatMb(1024), "1 GiB", "formatMb formats GiB boundary")
assertEqual(Model.formatMb(1536), "1.5 GiB", "formatMb formats fractional GiB")
assertEqual(Model.formatMb(-100), "0 MiB", "formatMb clamps negatives")
assertEqual(Model.formatMb(NaN), "0 MiB", "formatMb clamps NaN")

// ---------------------------------------------------------------------------
// clampMemMb
// ---------------------------------------------------------------------------

assertEqual(Model.clampMemMb(10, 8192), 128, "clampMemMb raises below minimum")
assertEqual(Model.clampMemMb(99999, 8192), 8192, "clampMemMb lowers above maximum")
assertEqual(Model.clampMemMb(2048, 8192), 2048, "clampMemMb keeps in-range values")
assertEqual(Model.clampMemMb(2048.6, 8192), 2049, "clampMemMb rounds to whole MiB")
assertEqual(Model.clampMemMb("abc", 8192), 128, "clampMemMb falls back for NaN input")
assertEqual(Model.clampMemMb(512, 64), 128, "clampMemMb survives a maximum below minimum")
assertEqual(Model.clampMemMb(512, "abc"), 128, "clampMemMb falls back for NaN maximum")
assertEqual(Model.clampMemMb(128, 128), 128, "clampMemMb handles equal bounds")

// ---------------------------------------------------------------------------
// parseSnapshot
// ---------------------------------------------------------------------------

const fullSample = [
  "==DOCKER==", "29.7.2",
  "==HOST==", "16766789632",
  "==CONTAINERS==",
  "abcd1234ef5678901234|/web-app|nginx:latest|running|536870912",
  "beef0001dead0002beef|cache-service|cache-service:1.2|running|0",
  "==STATS==",
  "web-app|0.12%|1.234GiB / 15.62GiB|7.90%",
  "cache-service|0.00%|512MiB / 15.62GiB|3.20%"
].join("\n")

const full = Model.parseSnapshot(fullSample)
assert(full.dockerAvailable === true, "parseSnapshot detects available daemon")
assertEqual(full.dockerVersion, "29.7.2", "parseSnapshot keeps daemon version")
assertEqual(full.hostMemBytes, 16766789632, "parseSnapshot parses host RAM")
assertEqual(full.containers.length, 2, "parseSnapshot parses all containers")
assertEqual(full.containers[0].id, "abcd1234ef56", "parseSnapshot truncates ids to 12 chars")
assertEqual(full.containers[0].name, "web-app", "parseSnapshot strips leading slash from names")
assertEqual(full.containers[0].status, "running", "parseSnapshot keeps container status")
assertEqual(full.containers[0].memLimitBytes, 536870912, "parseSnapshot parses configured limit")
assertEqual(full.containers[1].memLimitBytes, 0, "parseSnapshot keeps zero limit as unlimited")
assertEqual(full.containers[0].cpuPercent, "0.12%", "parseSnapshot joins stats by name")
assertEqual(full.containers[0].memUsageBytes, 1324997411, "parseSnapshot parses mem usage from stats")
assertEqual(full.containers[0].memPercent, "7.90%", "parseSnapshot keeps mem percent")
assertEqual(full.containers[1].cpuPercent, "0.00%", "parseSnapshot stats second container")

const unavailable = Model.parseSnapshot("==DOCKER==\nunavailable\n==HOST==\n0\n==CONTAINERS==\n==STATS==\n")
assert(unavailable.dockerAvailable === false, "parseSnapshot reports unavailable daemon")
assertEqual(unavailable.dockerVersion, "", "parseSnapshot clears version when unavailable")
assertEqual(unavailable.containers.length, 0, "parseSnapshot yields no containers when unavailable")

const empty = Model.parseSnapshot("")
assertEqual(empty, { dockerAvailable: false, dockerVersion: "", hostMemBytes: 0, containers: [] }, "parseSnapshot handles empty text")

const noStats = "==DOCKER==\n25.0\n==HOST==\n1024\n==CONTAINERS==\nid1|/foo|img|running|0\n"
assertEqual(Model.parseSnapshot(noStats).containers[0].cpuPercent, "", "parseSnapshot leaves stats blank when section is absent")
assertEqual(Model.parseSnapshot(noStats).containers[0].memUsageBytes, 0, "parseSnapshot leaves usage zero when section is absent")

const malformed = "==DOCKER==\n25.0\n==HOST==\n1024\n==CONTAINERS==\nid1|/foo|img|running|536870912|EXTRA\nid2|/bar|img2|running\nid3|/baz|img3|running|1024\n"
assertEqual(Model.parseSnapshot(malformed).containers.length, 2, "parseSnapshot skips short lines and keeps extra pipes")
assertEqual(Model.parseSnapshot(malformed).containers[0].name, "foo", "parseSnapshot first valid container wins")

const orphanStats = [
  "==DOCKER==", "25.0", "==HOST==", "1024", "==CONTAINERS==",
  "abc|/my-app|img|running|0",
  "==STATS==", "ghost|0.5%|1MiB / 8GiB|0.01%"
].join("\n")
assertEqual(Model.parseSnapshot(orphanStats).containers[0].cpuPercent, "", "parseSnapshot ignores stats for unknown containers")

const crlf = "==DOCKER==\r\n29.7\r\n==HOST==\r\n1024\r\n==CONTAINERS==\r\nid1|/foo|img|running|0\r\n==STATS==\r\n"
assertEqual(Model.parseSnapshot(crlf).dockerVersion, "29.7", "parseSnapshot tolerates CRLF line endings")

const weirdStats = [
  "==DOCKER==", "25.0", "==HOST==", "1024", "==CONTAINERS==",
  "abc|/my-app|img|running|0",
  "==STATS==", "my-app|--|-- / 8GiB|--"
].join("\n")
assertEqual(Model.parseSnapshot(weirdStats).containers[0].cpuPercent, "--", "parseSnapshot keeps docker's placeholder cpu value")
assertEqual(Model.parseSnapshot(weirdStats).containers[0].memUsageBytes, 0, "parseSnapshot maps placeholder mem usage to zero")

// ---------------------------------------------------------------------------
// snapshotScript
// ---------------------------------------------------------------------------

assert(Model.snapshotScript.indexOf("==DOCKER==") >= 0, "snapshotScript carries the DOCKER section header")
assert(Model.snapshotScript.indexOf("==HOST==") >= 0, "snapshotScript carries the HOST section header")
assert(Model.snapshotScript.indexOf("==CONTAINERS==") >= 0, "snapshotScript carries the CONTAINERS section header")
assert(Model.snapshotScript.indexOf("==STATS==") >= 0, "snapshotScript carries the STATS section header")
assert(Model.snapshotScript.indexOf("docker stats --no-stream") >= 0, "snapshotScript uses non-streaming stats")

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)