#!/usr/bin/env node
// Record terminal requests without opening windows during the Qt UI suite.
const fs = require("node:fs")
const args = process.argv.slice(2)
if (!process.env.DOCKER_PLUGIN_UI_TERMINALS) throw new Error("UI test terminal log required")
fs.appendFileSync(process.env.DOCKER_PLUGIN_UI_TERMINALS, JSON.stringify(args) + "\n")
