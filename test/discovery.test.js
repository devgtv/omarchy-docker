// Read-only discovery, formatting and identity regressions; no daemon access.
const assert = require("node:assert/strict")
const Model = require("../Model.js")
const {execFileSync} = require("node:child_process")
const a = {name: "api", fullId: "a".repeat(64), image: "example/api:latest", status: "running", project: "shop", service: "backend", health: "healthy"}
const b = {name: "cache", fullId: "b".repeat(64), image: "redis:7", status: "exited", project: "shop", health: ""}
const c = {name: "worker", fullId: "c".repeat(64), image: "example/worker", status: "paused", project: "alpha", health: "unhealthy"}
const d = {name: "standalone", fullId: "d".repeat(64), image: "busybox", status: "created", project: ""}
const all = [a, b, c, d]
let count = 0
function test(name, body) { body(); count++; console.log("ok - " + name) }
function view(query = "", state = "all", project = "", grouped = false) { return Model.visibleContainers(all, query, state, project, grouped) }
test("search is case-insensitive and matches image, name, project, service and ID", () => {
  for (const query of ["API", "latest", "backend", "aaaa"]) assert.deepEqual(view(query), [a])
  assert.deepEqual(view("shop"), [a, b])
})
test("search terms intersect and are literal, never regular expressions", () => {
  assert.deepEqual(view(" SHOP   Redis "), [b])
  assert.deepEqual(view(".*"), [])
  assert.deepEqual(view("missing"), [])
  assert.deepEqual(view("  "), all)
})
test("state and project filters intersect without changing the source", () => {
  assert.deepEqual(view("", "running", "shop"), [a])
  assert.deepEqual(view("", "stopped"), [b, d])
  assert.deepEqual(view("", "paused"), [c])
  assert.deepEqual(view("", "all", "missing"), [])
  assert.deepEqual(all, [a, b, c, d])
})
test("Compose grouping is deterministic and keeps standalone containers last", () => {
  assert.deepEqual(view("", "all", "", true), [c, a, b, d])
  assert.deepEqual(Model.projects([a, b, c, d, {...a, project: "__proto__"}]), ["__proto__", "alpha", "shop"])
})
test("selection follows immutable ID when filtering and grouping reorder rows", () => {
  assert.equal(Model.selectionIndex(all, [c, a, b, d], 0), 1)
  assert.equal(Model.selectionIndex(all, [b], 1), 0)
  assert.equal(Model.selectionIndex(all, [], 2), 0)
  assert.equal(Model.selectionIndex(all, [{...a, fullId: "e".repeat(64)}], 0), 0)
})
const extra = {health: "starting", project: "demo|世界\nproject", service: "web", ports: {"80/tcp": [{HostIp: "::", HostPort: "8080"}], "443/tcp": null}, mounts: [{Type: "bind", Source: "/tmp/it's|a\npath", Destination: "/data", RW: false}], startedAt: "2026-11-09T12:00:00Z", finishedAt: "0001-01-01T00:00:00Z", exitCode: 137, oomKilled: true, error: "<b>not markup</b>|\nerror"}
function snapshot(value) { return Model.parseSnapshot("==DOCKER==\n29\n==CONTAINERS==\n" + a.fullId + "|/api|img|running|0|" + value + "\n==STATS==\napi|1%|1MiB / 8GiB|1%") }
test("JSON metadata preserves delimiters, Unicode and escaped newlines", () => {
  const item = snapshot(JSON.stringify(extra)).containers[0]
  for (const key of Object.keys(extra)) assert.deepEqual(item[key], extra[key])
  assert.equal(item.memUsageBytes, 1048576)
})
test("legacy, malformed and unexpected metadata stay safe", () => {
  for (const value of ["", "garbage", "null", "[]", "42", '{"health":"invalid","ports":[],"mounts":[null,3],"exitCode":"0"}']) {
    const item = snapshot(value).containers[0]
    assert.equal(item.health, "")
    assert.deepEqual(item.ports, {})
    assert.deepEqual(item.mounts, [])
    assert.equal(item.exitCode, null)
    assert.doesNotThrow(() => Model.detailsText(item, Date.now()))
  }
})
test("ports distinguish IPv6, IPv4 and exposed but unpublished ports", () => {
  assert.equal(Model.portsText({ports: {"80/tcp": [{HostIp: "127.0.0.1", HostPort: "8080"}, {HostIp: "::", HostPort: "8080"}], "53/udp": null}}), "53/udp (not published)\n127.0.0.1:8080 → 80/tcp\n[::]:8080 → 80/tcp")
  assert.equal(Model.portsText({}), "")
})
test("details show mounts, health and last exit information without inferring a cause", () => {
  const text = Model.detailsText({...a, ...extra}, Date.parse("2026-11-09T13:05:00Z"))
  for (const expected of ["Uptime: 1h 5m", "Last exit code: 137 (OOM killed)", "read-only", extra.error, a.fullId]) assert(text.includes(expected))
  assert(Model.detailsText(b, Date.now()).includes("Last exit code: Unknown"))
})
test("uptime handles invalid, future, never-started and stopped containers", () => {
  const now = Date.parse("2026-11-09T13:05:00Z")
  for (const startedAt of ["", "invalid", "0001-01-01T00:00:00Z", "2027-01-01"]) assert.equal(Model.uptimeText({...a, startedAt}, now), "Unavailable")
  assert.equal(Model.uptimeText({...b, startedAt: extra.startedAt}, now), "Unavailable")
})
test("clipboard data cannot alter the constant shell program", () => {
  const payload = "$(exit 4); ' \" | <b>hello</b>\n世界"
  const command = Model.clipboardCommand(payload)
  assert.equal(command.at(-1), payload)
  assert.equal(command[4], Model.clipboardCommand("safe")[4])
  // A shell function substitutes for wl-copy; do not alter the user's clipboard.
  const output = execFileSync(command[0], command.slice(1), {encoding: "utf8", env: {...process.env, "BASH_FUNC_wl-copy%%": "() { cat; }"}})
  assert.equal(output, payload)
})
test("inspect output projects discovery fields, not environment or health logs", () => {
  assert(Model.inspectFormat.includes("com.docker.compose.project"))
  assert(Model.inspectFormat.includes("json .Mounts"))
  assert(!Model.inspectFormat.includes(".Config.Env"))
  assert(!Model.inspectFormat.includes(".State.Health.Log"))
})
console.log(`\n${count} discovery scenarios passed`)
