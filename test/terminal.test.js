// Opt-in real terminal test on Hyprland. Docker output is fake; no daemon access.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const {randomUUID} = require("node:crypto")
const {execFileSync, spawn} = require("node:child_process")
const Model = require("../Model.js")
if (process.env.DOCKER_PLUGIN_TERMINAL_TESTS !== "1") {
  console.log("ok - real terminal test requires DOCKER_PLUGIN_TERMINAL_TESTS=1; skipped")
  process.exit(0)
}
const output = process.env.DOCKER_PLUGIN_UI_OUTPUT
assert(output, "DOCKER_PLUGIN_UI_OUTPUT must name an artifact directory")
fs.mkdirSync(output, {recursive: true})
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-plugin-terminal-"))
const state = path.join(dir, "state.json")
const token = "docker-plugin-terminal-test-" + randomUUID()
const windows = []
const logPids = []
function exec(command, args) { return execFileSync(command, args, {encoding: "utf8", timeout: 10000}) }
function clients() { return JSON.parse(exec("hyprctl", ["-j", "clients"])) }
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check, message) {
  for (let i = 0; i < 100; i++) {
    const value = check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}
async function main() {
  fs.mkdirSync(path.join(dir, "bin"))
  fs.copyFileSync(path.join(__dirname, "ui", "docker.js"), path.join(dir, "bin", "docker"))
  fs.chmodSync(path.join(dir, "bin", "docker"), 0o755)
  const target = {kind: "context", value: "fake-terminal-test", endpoint: "unix:///not-a-real-daemon"}
  try {
    for (const follow of [false, true]) {
      const command = Model.logsCommand(target, {fullId: "a".repeat(64), name: token + (follow ? "-follow" : "-recent")}, follow)
      // Assign the fake CLI environment inside the terminal, even if the terminal
      // itself is launched by a server with a different inherited environment.
      command.splice(command.indexOf("docker"), 0, "PATH=" + path.join(dir, "bin") + path.delimiter + process.env.PATH, "DOCKER_PLUGIN_UI_STATE=" + state)
      const child = spawn(command[0], command.slice(1), {stdio: "ignore", detached: true})
      child.unref()
      const window = await until(() => clients().find(c => c.title.includes(token + (follow ? "-follow" : "-recent"))), "test terminal did not appear")
      windows.push(window.address)
    }
    await until(() => fs.existsSync(state + ".calls") && fs.readFileSync(state + ".calls", "utf8").trim().split("\n").filter(line => JSON.parse(line).action === "logs").length === 2, "fake logs did not execute in both terminals")
    const calls = fs.readFileSync(state + ".calls", "utf8").trim().split("\n").map(JSON.parse).filter(c => c.action === "logs")
    logPids.push(...calls.map(c => c.pid))
    const recent = calls.find(c => !c.args.includes("--follow"))
    const follow = calls.find(c => c.args.includes("--follow"))
    await until(() => !alive(recent.pid), "recent log command should have exited")
    assert(windows.every(address => clients().some(c => c.address === address)), "completed recent output must remain visible")
    console.log("ok - recent output remains open in the actual default terminal")
    for (const address of windows) {
      const c = clients().find(c => c.address === address)
      exec("grim", ["-g", c.at[0] + "," + c.at[1] + " " + c.size[0] + "x" + c.size[1], path.join(output, c.title.includes("-follow") ? "terminal-follow.png" : "terminal-recent.png")])
    }
    const followWindow = clients().find(c => c.title.includes(token + "-follow"))
    exec("hyprctl", ["dispatch", 'hl.dsp.send_shortcut({ mods = "CTRL", key = "C", window = "address:' + followWindow.address + '" })'])
    await until(() => !alive(follow.pid), "Ctrl+C did not stop the fake live log process")
    assert(clients().some(c => c.address === followWindow.address), "terminal must remain open after interrupting the stream")
    console.log("ok - targeted Ctrl+C stops following and retains the terminal output")
    for (const address of windows) exec("hyprctl", ["dispatch", 'hl.dsp.send_shortcut({ mods = "", key = "Return", window = "address:' + address + '" })'])
    await until(() => windows.every(address => !clients().some(c => c.address === address)), "Enter did not close completed test log terminals")
    console.log("ok - Enter closes both completed test log terminals")
  } finally {
    for (const address of windows) {
      if (clients().some(c => c.address === address)) exec("hyprctl", ["dispatch", 'hl.dsp.window.close({ window = "address:' + address + '" })'])
    }
    for (const pid of logPids) {
      if (alive(pid) && fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").includes(path.join(dir, "bin", "docker"))) process.kill(pid, "SIGTERM")
    }
    fs.rmSync(dir, {recursive: true, force: true})
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
