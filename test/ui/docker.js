#!/usr/bin/env node
// Fake Docker CLI for graphical tests. It never connects to a daemon.
const fs = require("node:fs")
const file = process.env.DOCKER_PLUGIN_UI_STATE
if (!file) throw new Error("UI test state path required")
const args = process.argv.slice(2)
const initial = [
  {id: "a".repeat(64), name: "ui-running-web", status: "running", memory: 67108864},
  {id: "b".repeat(64), name: "ui-stopped-web", status: "exited", memory: 67108864}
]
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({containers: initial}))
const state = JSON.parse(fs.readFileSync(file, "utf8"))
function save() { fs.writeFileSync(file, JSON.stringify(state)) }
function out(text) { console.log(text); process.exit(0) }
function fail(text) { console.error(text); process.exit(1) }
if (args[0] === "context") {
  if (args[1] === "show") out("ui-disposable-test")
  if (args[1] === "inspect") out("unix:///ui-test/not-a-real-docker.sock")
}
if (["--context", "--host"].includes(args[0])) args.splice(0, 2)
const action = args.shift()
fs.appendFileSync(file + ".calls", JSON.stringify({action, args, pid: process.pid}) + "\n")
if (action === "test-deny") { state.failWrites = true; save(); out("ok") }
const c = state.containers.find(c => c.id === args.at(-1))
if (action === "version") out("29.0-test")
if (action === "info") out("8589934592")
if (action === "ps") out(state.containers.filter(c => args.includes("-aq") || c.status === "running").map(c => c.id).join("\n"))
if (action === "inspect") out(state.containers.map(c => `${c.id}|/${c.name}|busybox:test|${c.status}|${c.memory}`).join("\n"))
if (action === "stats") out(state.containers.filter(c => c.status === "running").map(c => `${c.name}|1.00%|8MiB / 8GiB|0.10%`).join("\n"))
if (!["start", "stop", "restart", "update", "logs"].includes(action) || !c) fail("Invalid fake Docker test command")
if (state.failWrites && action !== "logs") fail("Synthetic permission denied for UI test")
if (action === "start" || action === "restart") c.status = "running"
if (action === "stop") c.status = "exited"
if (action === "update" && args.includes("--memory")) c.memory = parseInt(args[args.indexOf("--memory") + 1], 10) * 1048576
if (action === "logs") {
  if (!args.includes("--follow")) out("2026-11-09T00:00:00Z disposable-ui-log")
  console.log("2026-11-09T00:00:00Z disposable-ui-log")
  setInterval(() => console.log(new Date().toISOString() + " disposable-ui-live-log"), 1000)
} else { save(); out(c.id) }
