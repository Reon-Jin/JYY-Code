import { fileURLToPath } from "node:url"

const desktopDirectory = fileURLToPath(new URL("..", import.meta.url))

export function tauriBuildEnvironment(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment }
  if (platform === "darwin") result.CI = "true"
  return result
}

export async function runTauriBuild(arguments_: string[] = Bun.argv.slice(2)) {
  const child = Bun.spawn([process.execPath, "run", "--bun", "tauri", "build", ...arguments_], {
    cwd: desktopDirectory,
    env: tauriBuildEnvironment(process.platform, process.env),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return child.exited
}

if (import.meta.main) {
  process.exit(await runTauriBuild())
}
