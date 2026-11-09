// Explicitly opt-in integration tests. Only this script's labeled containers
// may be mutated or removed. Never run against a production Docker endpoint.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const {randomUUID} = require("node:crypto")
const {execFileSync, spawn} = require("node:child_process")
const Model = require("../Model.js")

if (process.env.DOCKER_PLUGIN_DISPOSABLE_TESTS !== "1") {
  console.log("ok - disposable write tests require DOCKER_PLUGIN_DISPOSABLE_TESTS=1; skipped")
  process.exit(0)
}
const image = "busybox:1.37.0@sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4"
const runId = randomUUID()
const label = "devgtv.docker.disposable-test"
const created = []
let target
let passes = 0
function exec(command, timeout = 30000) {
  assert(command.length > 0, "empty command")
  return execFileSync(command[0], command.slice(1), {encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"]})
}
function docker(args, timeout) { return exec(Model.dockerCommand(target, args), timeout) }
function inspect(id) { return JSON.parse(docker(["inspect", id]))[0] }
function owned(id) {
  assert(created.includes(id), "refuse an ID not created by this test")
  assert.equal(inspect(id).Config.Labels[label], runId, "refuse a foreign container")
}
function ok(message) { passes++; console.log("ok - " + message) }
function snapshot() { return Model.parseSnapshot(exec(["bash", "-c", Model.snapshotScript])) }

const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
const functions = [...source.matchAll(/^  function (\w+)\(([^\n]*)\) \{([\s\S]*?)^  \}/gm)]
  .map(match => `function ${match[1]}(${match[2]}) {${match[3]}\n}`)
const ctx = vm.createContext({Model, Qt: {callLater(fn) { fn() }}, dockerAvailable: true, dockerTarget: null,
  containers: [], pendingSets: [], activeSet: null, keyboardEdits: {}, memOverrides: {},
  pendingAction: null, activeAction: null, actionError: "", actionNotice: "",
  userInteracting: false, mutationRevision: 0, selectedIndex: 0, cursorActive: true,
  memMin: 6, memStep: 128, hostMemMb: 8192,
  actionProc: {running: false}, setProc: {running: false}, refreshProc: {running: false},
  memDebounce: {running: false, restart() { this.running = true }}
})
ctx.root = ctx
Object.defineProperty(ctx, "controlsBusy", {get() {
  return ctx.userInteracting || ctx.memDebounce.running || ctx.setProc.running || ctx.activeSet !== null || ctx.pendingSets.length > 0 || ctx.actionProc.running || ctx.activeAction !== null || ctx.pendingAction !== null
}})
vm.runInContext(functions.join("\n"), ctx)
function sync() {
  const snap = snapshot()
  ctx.containers = snap.containers.filter(c => created.includes(c.fullId))
  ctx.dockerTarget = snap.target
  ctx.hostMemMb = Model.hostMemoryMb(snap.hostMemBytes)
  ctx.refreshProc.running = false
  return ctx.containers
}
function action(verb, id) {
  owned(id)
  const c = ctx.containers.find(item => item.fullId === id)
  ctx.requestAction(verb, c)
  assert(ctx.pendingAction, "confirmation must be requested")
  assert.equal(ctx.actionProc.running, false, "no write before confirmation")
  ctx.confirmAction()
  const command = Array.from(ctx.actionProc.command)
  assert.equal(command.at(-1), id)
  exec(command)
  ctx.actionProc.running = false
  ctx.finishAction(0, 0, "")
  assert.equal(ctx.actionError, "")
  sync()
}

function memory(id, mb) {
  owned(id)
  const c = ctx.containers.find(c => c.fullId === id)
  ctx.setMemory(c.name, mb)
  const job = ctx.activeSet
  assert(job, "memory job must start")
  while (ctx.activeSet === job) {
    exec(Array.from(ctx.setProc.command))
    const config = inspect(id).HostConfig
    console.log("# memory stage " + job.phase + ": " + JSON.stringify({memory: config.Memory, memorySwap: config.MemorySwap}))
    ctx.setProc.running = false
    ctx.finishSet(0, 0, "")
  }
  assert.equal(inspect(id).HostConfig.Memory, mb * 1048576)
  assert.equal(inspect(id).HostConfig.MemorySwap, -1)
  sync()
}

async function main() {
  const initial = snapshot()
  target = initial.target
  assert(initial.dockerAvailable && Model.validTarget(target), "reachable Docker target required")
  assert(/^unix:\/\//.test(target.endpoint), "write tests require a local Unix socket")
  assert.equal(process.arch, "x64", "the pinned test image targets Linux amd64")
  docker(["pull", image], 120000)
  const workload = "trap 'exit 0' TERM INT; i=0; while :; do echo disposable-log-$i; i=$((i+1)); sleep 1; done"
  try {
    for (let i = 0; i < 2; i++) {
      const id = docker(["create", "--name", "docker-plugin-test-" + runId + "-" + i,
        "--label", label + "=" + runId, "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "32",
        ...(i === 0 ? ["--memory", "64m", "--memory-swap", "64m"] : []), image, "sh", "-c", workload]).trim()
      assert(/^[a-f0-9]{64}$/.test(id))
      created.push(id)
    }
    sync()
    assert.equal(ctx.containers.length, 2)
    assert(ctx.containers.every(c => c.status === "created" && c.cpuPercent === ""))
    ok("snapshot lists two created containers without running stats")

    ctx.requestAction("start", ctx.containers.find(c => c.fullId === created[0]))
    ctx.cancelAction()
    assert.equal(inspect(created[0]).State.Status, "created")
    ok("canceled controller confirmation performs no lifecycle write")

    action("start", created[0])
    assert.equal(inspect(created[0]).State.Status, "running")
    assert.equal(inspect(created[1]).State.Status, "created")
    ok("confirmed controller Start affects only the captured container")

    action("start", created[1])
    assert(ctx.containers.every(c => c.status === "running" && c.cpuPercent !== ""))
    ok("snapshot collects real resource stats for multiple running containers")

    memory(created[0], 128)
    assert.equal(inspect(created[1]).HostConfig.Memory, 0)
    ok("controller RAM update uses the full ID and leaves the other container unchanged")
    memory(created[1], 96)
    ok("an initially unlimited container accepts its first finite RAM limit")
    memory(created[0], 64)
    ok("a running container accepts a lower RAM limit and retains unlimited swap")

    const startedAt = inspect(created[0]).State.StartedAt
    action("restart", created[0])
    assert.notEqual(inspect(created[0]).State.StartedAt, startedAt)
    ok("confirmed controller Restart restarts the selected workload")

    const c = ctx.containers.find(c => c.fullId === created[0])
    const logs = Model.logsCommand(target, c, false)
    const dockerPart = logs.slice(logs.indexOf("env"))
    assert.match(exec(dockerPart), /\d{4}-\d{2}-\d{2}T.*disposable-log-/)
    ok("recent-log command reads timestamped output from the real container")

    const follow = Model.logsCommand(target, c, true)
    const followCommand = follow.slice(follow.indexOf("env"))
    await new Promise((resolve, reject) => {
      const child = spawn(followCommand[0], followCommand.slice(1), {stdio: ["ignore", "pipe", "pipe"]})
      let output = ""
      let interrupted = false
      let firstOutputAt = null
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("live logs timed out")) }, 10000)
      child.stdout.on("data", data => {
        output += data
        if (firstOutputAt === null) firstOutputAt = Date.now()
        if (!interrupted && Date.now() - firstOutputAt >= 900 && (output.match(/disposable-log-/g) || []).length >= 2) {
          interrupted = true
          child.kill("SIGINT")
        }
      })
      child.on("error", error => { clearTimeout(timer); reject(error) })
      child.on("close", () => {
        clearTimeout(timer)
        if (!interrupted) reject(new Error("live log stream ended without output"))
        else resolve()
      })
    })
    assert.equal(inspect(created[0]).State.Status, "running")
    ok("live-log command streams output and SIGINT does not stop the container")

    action("stop", created[0])
    assert.equal(inspect(created[0]).State.Status, "exited")
    assert.equal(inspect(created[1]).State.Status, "running")
    ok("confirmed controller Stop affects only the selected container")
    const stopped = ctx.containers.find(c => c.fullId === created[0])
    assert.equal(stopped.cpuPercent, "")
    assert.match(exec(Model.dockerCommand(target, ["logs", "--tail", "200", "--", stopped.fullId])), /disposable-log-/)
    ok("stopped containers retain readable logs and do not receive resource stats")
    action("start", created[0])
    ok("an exited container can be started again through the controller")
  } finally {
    for (const id of created) {
      owned(id)
      docker(["rm", "--force", "--", id])
    }
    const remaining = docker(["ps", "-aq", "--filter", "label=" + label + "=" + runId]).trim()
    assert.equal(remaining, "", "all disposable containers must be removed")
    ok("cleanup removed only containers owned by this test run")
  }
  console.log(`\n${passes} real Docker scenarios passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
