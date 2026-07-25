#!/usr/bin/env node

const childProcess = require("child_process")
const fs = require("fs")
const path = require("path")

if (process.env.npm_config_global === "true") {
  process.exit(0)
}

const husky = path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "husky.cmd" : "husky")

if (!fs.existsSync(husky)) {
  process.exit(0)
}

const result = childProcess.spawnSync(husky, {
  stdio: "inherit",
  shell: false,
})

process.exit(result.status ?? 0)
