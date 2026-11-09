// Execute the actual QML controller functions with fake Process/Timer objects.
// This is not a visual or Quickshell runtime test; no Docker writes are made.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const source = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
const functions = [...source.matchAll(/^  function (\w+)\(([^\n]*)\) \{([\s\S]*?)^  \}/gm)]
  .map(match => `function ${match[1]}(${match[2]}) {${match[3]}\n}`)
const ctx = vm.createContext({
  Model: require("../Model.js"),
  Quickshell: {execDetached(command) { launched.push(Array.from(command)) }},
  dockerTarget: {kind: "context", value: "test", endpoint: "unix:///test.sock"},
  dockerAvailable: true, pendingAction: null, activeAction: null, actionProc: {running: false},
  actionNotice: "", mutationRevision: 0,
  pendingSets: [], activeSet: null, keyboardEdits: {}, memOverrides: {},
  containers: [{name: "web", status: "running", fullId: "a".repeat(64), memLimitBytes: 512 * 1048576}, {name: "db", status: "running", fullId: "b".repeat(64), memLimitBytes: 1024 * 1048576}],
  selectedIndex: 0, hostMemMb: 8192, memMin: 6, memStep: 128,
  userInteracting: false, actionError: "", setProc: {running: false},
  refreshProc: {running: false},
  memDebounce: {running: false, restart() { this.running = true }}
})
const launched = []
ctx.root = ctx
Object.defineProperty(ctx, "controlsBusy", {get() {
  return ctx.userInteracting || ctx.memDebounce.running || ctx.setProc.running || ctx.pendingSets.length > 0 || ctx.actionProc.running || ctx.pendingAction !== null
}})
vm.runInContext(functions.join("\n"), ctx)
let passes = 0
function test(name, body) {
  body()
  passes++
  console.log("ok - " + name)
}
function finish(code = 0, status = 0, message = "") {
  ctx.setProc.running = false
  ctx.finishSet(code, status, message)
}

test("controller retains the in-flight job identity explicitly", () => {
  ctx.setMemory("web", 640)
  assert.equal(ctx.activeSet.name, "web")
  assert.equal(ctx.setProc.command.at(-2), "-1")
  assert.equal(ctx.setProc.command.at(-1), "a".repeat(64))
  assert.equal(ctx.setProc.command[7], "test")
})
test("repeated queued updates coalesce to the latest limit", () => {
  ctx.setMemory("web", 768)
  ctx.setMemory("web", 896)
  assert.equal(ctx.pendingSets.length, 1)
  assert.equal(ctx.pendingSets[0].mb, 896)
})
test("finishing an old job keeps the newer preview and starts the next job", () => {
  finish()
  assert.equal(ctx.memOverrides.web, 896)
  assert.equal(ctx.activeSet.mb, 896)
})
test("finishing the final job clears the correct override and refreshes", () => {
  finish()
  assert.equal(ctx.memOverrides.web, undefined)
  assert.equal(ctx.refreshProc.running, true)
})
test("keyboard edits stay attached to their containers when selection changes", () => {
  ctx.adjustSelectedMem(1)
  ctx.selectedIndex = 1
  ctx.adjustSelectedMem(-1)
  ctx.memDebounce.running = false
  ctx.flushKeyboardEdits()
  assert.equal(ctx.activeSet.name, "web")
  assert.equal(ctx.activeSet.mb, 640)
  assert.equal(ctx.pendingSets[0].name, "db")
  assert.equal(ctx.pendingSets[0].mb, 896)
})
test("failed updates surface Docker stderr and do not block the queue", () => {
  finish(1, 0, "  permission denied\n")
  assert.equal(ctx.actionError, "Could not update web: permission denied")
  assert.equal(ctx.activeSet.name, "db")
  assert.equal(ctx.memOverrides.web, undefined)
  finish()
})
test("crashed updates report a fallback error", () => {
  ctx.setMemory("web", 640)
  finish(9, 1)
  assert.match(ctx.actionError, /Could not update web: Docker exited with code 9/)
})
test("completion preserves an unsent keyboard preview for the same container", () => {
  ctx.setMemory("web", 640)
  ctx.selectedIndex = 0
  ctx.adjustSelectedMem(1)
  finish()
  assert.equal(ctx.memOverrides.web, 768)
  ctx.memDebounce.running = false
  ctx.flushKeyboardEdits()
  finish()
})
test("removed containers are not updated by a delayed keyboard edit", () => {
  ctx.keyboardEdits = {removed: 512}
  ctx.memOverrides = {removed: 512}
  ctx.flushKeyboardEdits()
  assert.equal(ctx.activeSet, null)
  assert.equal(ctx.memOverrides.removed, undefined)
})
test("a slider release supersedes an older keyboard edit on that container", () => {
  ctx.selectedIndex = 0
  ctx.adjustSelectedMem(1)
  ctx.setMemory("web", 2048)
  assert.equal(ctx.keyboardEdits.web, undefined)
  ctx.memDebounce.running = false
  ctx.flushKeyboardEdits()
  assert.equal(ctx.pendingSets.length, 0)
  assert.equal(ctx.activeSet.mb, 2048)
  finish()
})
test("refresh waits for interaction and pending keyboard edits", () => {
  ctx.refreshProc.running = false
  ctx.userInteracting = true
  ctx.refresh()
  assert.equal(ctx.refreshProc.running, false)
  ctx.userInteracting = false
  ctx.memDebounce.running = true
  ctx.refresh()
  assert.equal(ctx.refreshProc.running, false)
  ctx.memDebounce.running = false
  ctx.refresh()
  assert.equal(ctx.refreshProc.running, true)
})
test("requesting lifecycle actions never executes before confirmation", () => {
  ctx.requestAction("stop", ctx.containers[0])
  assert.equal(ctx.pendingAction.action, "stop")
  assert.equal(ctx.actionProc.running, false)
  ctx.cancelAction()
  ctx.confirmAction()
  assert.equal(ctx.actionProc.running, false)
})
test("confirmation pins the original full ID and target despite selection changes", () => {
  ctx.requestAction("restart", ctx.containers[0])
  ctx.selectedIndex = 1
  const oldTarget = ctx.dockerTarget
  ctx.dockerTarget = {kind: "context", value: "other"}
  ctx.confirmAction()
  assert.equal(ctx.actionProc.command[7], "test")
  assert.deepEqual(Array.from(ctx.actionProc.command.slice(-3)), ["restart", "--", "a".repeat(64)])
  ctx.dockerTarget = oldTarget
})
test("lifecycle writes exclude memory edits and other lifecycle requests", () => {
  ctx.setMemory("db", 2048)
  ctx.requestAction("stop", ctx.containers[1])
  assert.equal(ctx.pendingSets.length, 0)
  assert.equal(ctx.setProc.running, false)
  assert.equal(ctx.pendingAction, null)
  ctx.actionProc.running = false
  ctx.finishAction(1, 0, "access denied")
  assert.equal(ctx.actionError, "Could not restart web: access denied")
})
test("successful lifecycle completion reports success and refreshes", () => {
  ctx.requestAction("stop", ctx.containers[1])
  ctx.confirmAction()
  ctx.refreshProc.running = false
  ctx.actionProc.running = false
  ctx.finishAction(0, 0, "")
  assert.equal(ctx.actionNotice, "Completed stop for db")
  assert.equal(ctx.refreshProc.running, true)
})
test("stopped container memory is not modified by keyboard or direct calls", () => {
  ctx.containers.push({name: "stopped", status: "exited", fullId: "c".repeat(64)})
  ctx.selectedIndex = 2
  ctx.adjustSelectedMem(1)
  ctx.setMemory("stopped", 512)
  assert.equal(ctx.setProc.running, false)
  assert.equal(ctx.keyboardEdits.stopped, undefined)
})
test("snapshots record the current mutation revision", () => {
  ctx.refreshProc.running = false
  ctx.refresh()
  assert.equal(ctx.refreshProc.revision, ctx.mutationRevision)
})
test("recent and follow logs launch independently without blocking the panel", () => {
  ctx.openLogs(ctx.containers[0], false)
  ctx.openLogs(ctx.containers[1], true)
  assert.equal(launched.length, 2)
  assert.equal(launched[0].includes("--follow"), false)
  assert.equal(launched[1].includes("--follow"), true)
  assert.equal(launched[0].at(-1), "a".repeat(64))
  assert.equal(ctx.controlsBusy, false)
})
test("log shortcuts respect selection and do not launch behind confirmations", () => {
  ctx.cursorActive = true
  ctx.selectedIndex = 2
  ctx.selectedLogs(false)
  assert.equal(launched.at(-1).at(-1), "c".repeat(64))
  ctx.requestAction("start", ctx.containers[2])
  const count = launched.length
  ctx.openLogs(ctx.containers[0], true)
  assert.equal(launched.length, count)
  ctx.cancelAction()
})
console.log(`\n${passes} controller tests passed`)
