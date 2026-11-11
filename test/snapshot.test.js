// Exercise the real Bash collector against a fake Docker CLI, never a daemon.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const {execFileSync, spawnSync} = require("node:child_process")
const Model = require("../Model.js")
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-plugin-test-"))
try {
  fs.writeFileSync(path.join(dir, "docker"), `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args, context: process.env.DOCKER_CONTEXT, host: process.env.DOCKER_HOST}) + "\\n")
if (args[0] === "context" && args[1] === "show") { console.log("desktop"); process.exit(0) }
if (args[0] === "context" && args[1] === "inspect") { console.log("ssh://server"); process.exit(0) }
if (args[0] !== "--context" && args[0] !== "--host") process.exit(2)
const command = args[2]
if (process.env.MODE === "hang" && command === "ps") setInterval(() => {}, 1000)
else if (process.env.MODE === "allocate" && command === "inspect") {
  const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8").split("\\n").find(line => line.startsWith("0::")).slice(3)
  const control = name => fs.readFileSync("/sys/fs/cgroup" + cgroup + "/" + name, "utf8").trim()
  fs.writeFileSync(process.env.ALLOC_MARKER, JSON.stringify({
    memoryMax: control("memory.max"), swapMax: control("memory.swap.max"), oomGroup: control("memory.oom.group")
  }))
  const retained = []
  while (true) retained.push(Buffer.alloc(16 * 1024 * 1024, 1))
}
else if (process.env.MODE === "huge" && command === "inspect") process.stdout.write("x".repeat(1024 * 1024))
else if (process.env.MODE === "row" && command === "inspect") console.log("a|" + "x".repeat(20000))
else if (process.env.MODE === "count" && command === "ps") console.log(Array(129).fill("abc123").join("\\n"))
else
if (command === "version") console.log("29.0")
else if (command === "info") console.log(args.some(arg => arg.includes(".NCPU")) ? "4" : "8589934592")
else if (command === "ps") console.log(args.includes("-aq") ? "abc123\\nstopped456" : "abc123")
else if (command === "inspect") console.log("abc123|/web|nginx|running|0|{\\\"nanoCpus\\\":2000000000}\\nstopped456|/old-web|nginx|exited|0|{\\\"nanoCpus\\\":0}")
else if (command === "stats") console.log("web|1%|16MiB / 8GiB|0.2%")
else process.exit(3)
`, {mode: 0o755})
  for (const [context, host, kind, value] of [
    ["", "", "context", "desktop"],
    ["production", "tcp://ignored:2376", "context", "production"],
    ["", "tcp://remote:2376", "host", "tcp://remote:2376"]
  ]) {
    const log = path.join(dir, "calls.jsonl")
    fs.writeFileSync(log, "")
    const output = execFileSync("bash", ["-c", Model.snapshotScript], {
      encoding: "utf8", env: {...process.env, PATH: dir + path.delimiter + process.env.PATH,
        CALL_LOG: log, DOCKER_CONTEXT: context, DOCKER_HOST: host}
    })
    const snap = Model.parseSnapshot(output)
    assert.equal(snap.target.kind, kind)
    assert.equal(snap.target.value, value)
    assert.equal(snap.hostMemBytes, 8589934592)
    assert.equal(snap.hostCpuCount, 4)
    assert.equal(snap.containers[0].cpuLimit, 2)
    assert.equal(snap.containers[0].memUsageBytes, 16 * 1048576)
    assert.equal(snap.containers[1].status, "exited")
    assert.equal(snap.containers[1].memUsageBytes, 0)
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line))
    const daemonCalls = calls.filter(call => call.args[0].startsWith("--"))
    assert.equal(daemonCalls.length, 6)
    for (const call of daemonCalls) {
      assert.deepEqual(call.args.slice(0, 2), ["--" + kind, value])
      assert.equal(call.context, undefined)
      assert.equal(call.host, undefined)
    }
    assert.equal(daemonCalls.find(call => call.args[2] === "stats").args.at(-1), "abc123")
    assert.equal(daemonCalls.find(call => call.args[2] === "inspect").args[4], Model.inspectFormat)
    console.log("ok - snapshot freezes " + kind + " target " + value)
  }
  const env = {...process.env, PATH: dir + path.delimiter + process.env.PATH,
    CALL_LOG: path.join(dir, "calls.jsonl"), DOCKER_CONTEXT: "desktop", DOCKER_HOST: ""}
  for (const mode of ["huge", "row", "count", "hang"]) {
    const result = spawnSync("timeout", ["-k", "1s", "2s", "bash", "-c", Model.snapshotScript],
      {encoding: "utf8", env: {...env, MODE: mode}, timeout: 5000, maxBuffer: 400000})
    assert.notEqual(result.status, 0, mode + " must fail")
    assert.doesNotMatch(result.stdout, /\n==COMPLETE==\s*$/)
    assert.ok(Buffer.byteLength(result.stdout) < 310000, mode + " output stays bounded")
    if (mode === "hang") assert.equal(result.status, 124)
    const recovery = execFileSync("timeout", ["-k", "1s", "5s", "bash", "-c", Model.snapshotScript], {encoding: "utf8", env})
    assert.match(recovery, /\n==COMPLETE==\s*$/)
    assert.equal(Model.parseSnapshot(recovery).containers.length, 2)
    console.log("ok - " + mode + " fails safely and the next snapshot succeeds")
  }

  const probe = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "true"], {encoding: "utf8"})
  assert.equal(probe.status, 0, "snapshot tests require the systemd user manager: " + probe.stderr.trim())
  const marker = path.join(dir, "allocation.json")
  const allocation = spawnSync(Model.snapshotCommand[0], Model.snapshotCommand.slice(1), {
    encoding: "utf8", env: {...env, MODE: "allocate", ALLOC_MARKER: marker}, timeout: 10000, maxBuffer: 400000
  })
  assert.equal(allocation.error, undefined, "allocation probe must be stopped by the cgroup, not the test timeout")
  assert.ok(allocation.signal === "SIGKILL" || (Number.isInteger(allocation.status) && allocation.status !== 0),
    "allocation before stdout must terminate the memory-capped scope")
  assert.doesNotMatch(allocation.stdout, /\n==COMPLETE==\s*$/)
  assert.ok(Buffer.byteLength(allocation.stdout) < 310000, "allocation failure output stays bounded")
  assert.ok(fs.existsSync(marker), "allocation probe did not reach inspect: " + allocation.stderr.trim())
  const limits = JSON.parse(fs.readFileSync(marker, "utf8"))
  assert.deepEqual(limits, {
    memoryMax: String(Model.SNAPSHOT_MEMORY_MAX_BYTES), swapMax: "0", oomGroup: "1"
  })
  const recovery = execFileSync(Model.snapshotCommand[0], Model.snapshotCommand.slice(1), {
    encoding: "utf8", env: env, timeout: 20000
  })
  assert.match(recovery, /\n==COMPLETE==\s*$/)
  assert.equal(Model.parseSnapshot(recovery).containers.length, 2)
  console.log("ok - allocation before stdout is cgroup-bounded and the next snapshot succeeds")
} finally {
  fs.rmSync(dir, {recursive: true, force: true})
}
