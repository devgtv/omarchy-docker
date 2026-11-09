#!/usr/bin/env node
// Isolated clipboard fixture; never changes the user's clipboard.
const fs = require("node:fs")
if (!process.env.DOCKER_PLUGIN_UI_CLIPBOARD) throw new Error("Clipboard fixture path required")
fs.writeFileSync(process.env.DOCKER_PLUGIN_UI_CLIPBOARD, fs.readFileSync(0))
