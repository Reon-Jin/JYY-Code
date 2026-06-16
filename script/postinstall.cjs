#!/usr/bin/env node

const childProcess = require("child_process")

if (process.env.npm_config_global === "true") {
  process.exit(0)
}

const result = childProcess.spawnSync("bun", ["run", "--cwd", "packages/jyycode", "fix-node-pty"], {
  stdio: "inherit",
  shell: process.platform === "win32",
})

if (result.error && result.error.code === "ENOENT") {
  process.exit(0)
}

process.exit(result.status ?? 0)
