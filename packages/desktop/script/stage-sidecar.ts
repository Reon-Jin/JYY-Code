import { copyFile, mkdir, stat } from "node:fs/promises"
import { resolve } from "node:path"

type SupportedArchitecture = "x64"

const packageRoot = resolve(import.meta.dir, "..")
const jyycodeRoot = resolve(packageRoot, "../jyycode")
const binariesRoot = resolve(packageRoot, "src-tauri/binaries")

function assertSupportedArchitecture(architecture: string): asserts architecture is SupportedArchitecture {
  if (architecture !== "x64") {
    throw new Error(`Unsupported architecture for phase 1: ${architecture}`)
  }
}

export function sidecarName(architecture: string) {
  assertSupportedArchitecture(architecture)
  return "jyycode-sidecar-x86_64-pc-windows-msvc.exe"
}

export function sourceBinary(architecture: string) {
  assertSupportedArchitecture(architecture)
  return resolve(jyycodeRoot, "dist/jyycode-windows-x64/bin/jyycode.exe")
}

async function runBuild() {
  const child = Bun.spawn([Bun.which("bun") ?? process.execPath, "run", "build", "--single", "--skip-embed-web-ui"], {
    cwd: jyycodeRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`JYYCode sidecar build failed with exit code ${exitCode}`)
}

async function verifyBinary(path: string) {
  const metadata = await stat(path).catch(() => undefined)
  if (!metadata?.isFile()) throw new Error(`Sidecar source binary does not exist: ${path}`)

  const result = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`Sidecar version check failed with exit code ${result.exitCode}`)
  }
}

export async function stageSidecar(options: { skipBuild?: boolean } = {}) {
  if (process.platform !== "win32") throw new Error(`Unsupported platform for phase 1: ${process.platform}`)
  assertSupportedArchitecture(process.arch)

  if (!options.skipBuild) await runBuild()
  const source = sourceBinary(process.arch)
  await verifyBinary(source)
  await mkdir(binariesRoot, { recursive: true })

  const destination = resolve(binariesRoot, sidecarName(process.arch))
  await copyFile(source, destination)
  return destination
}

if (import.meta.main) {
  const destination = await stageSidecar({ skipBuild: Bun.argv.includes("--skip-build") })
  console.log(`Staged JYYCode sidecar: ${destination}`)
}
