// Starts the interactive PowerShell launcher from a Node runtime when the
// caller's shell does not expose the user-installed Bun command on PATH.
const { spawn } = require("node:child_process")
const { join } = require("node:path")

const launcher = join(__dirname, "start-safari-quick-tunnel.ps1")
const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "-ForceTryCloudflareIPv4"],
  { stdio: "inherit", windowsHide: false },
)
child.on("exit", (code) => process.exit(code ?? 1))
