// Exercise the real Bash collector against a fake Docker CLI, never a daemon.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const {execFileSync} = require("node:child_process")
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
if (command === "version") console.log("29.0")
else if (command === "info") console.log("8589934592")
else if (command === "ps") console.log("abc123")
else if (command === "inspect") console.log("abc123|/web|nginx|running|0")
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
    assert.equal(snap.containers[0].memUsageBytes, 16 * 1048576)
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line))
    const daemonCalls = calls.filter(call => call.args[0].startsWith("--"))
    assert.equal(daemonCalls.length, 5)
    for (const call of daemonCalls) {
      assert.deepEqual(call.args.slice(0, 2), ["--" + kind, value])
      assert.equal(call.context, undefined)
      assert.equal(call.host, undefined)
    }
    assert.equal(daemonCalls.find(call => call.args[2] === "stats").args.at(-1), "abc123")
    console.log("ok - snapshot freezes " + kind + " target " + value)
  }
} finally {
  fs.rmSync(dir, {recursive: true, force: true})
}
