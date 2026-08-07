import { chmod, copyFile, mkdir, stat } from "node:fs/promises"
import { resolve } from "node:path"

type SupportedTarget =
  | {
      platform: "win32"
      architecture: "x64"
      triple: "x86_64-pc-windows-msvc"
      distribution: "jyycode-windows-x64"
      executable: "jyycode.exe"
    }
  | {
      platform: "darwin"
      architecture: "arm64"
      triple: "aarch64-apple-darwin"
      distribution: "jyycode-darwin-arm64"
      executable: "jyycode"
    }

const packageRoot = resolve(import.meta.dir, "..")
const jyycodeRoot = resolve(packageRoot, "../jyycode")
const binariesRoot = resolve(packageRoot, "src-tauri/binaries")

export function sidecarTarget(platform: string, architecture: string): SupportedTarget {
  if (platform === "win32" && architecture === "x64") {
    return {
      platform,
      architecture,
      triple: "x86_64-pc-windows-msvc",
      distribution: "jyycode-windows-x64",
      executable: "jyycode.exe",
    }
  }
  if (platform === "darwin" && architecture === "arm64") {
    return {
      platform,
      architecture,
      triple: "aarch64-apple-darwin",
      distribution: "jyycode-darwin-arm64",
      executable: "jyycode",
    }
  }
  throw new Error(`Unsupported desktop target: ${platform}/${architecture}`)
}

export function sidecarName(platform: string, architecture: string) {
  const target = sidecarTarget(platform, architecture)
  const extension = target.platform === "win32" ? ".exe" : ""
  return `jyycode-sidecar-${target.triple}${extension}`
}

export function sourceBinary(platform: string, architecture: string) {
  const target = sidecarTarget(platform, architecture)
  return resolve(jyycodeRoot, "dist", target.distribution, "bin", target.executable)
}

async function runBuild(dev: boolean) {
  const child = Bun.spawn(
    [Bun.which("bun") ?? process.execPath, "run", "build", "--single", "--skip-install", "--skip-embed-web-ui"],
    {
      cwd: jyycodeRoot,
      env: dev ? { ...process.env, JYYCODE_DEV_TRACE: "1" } : undefined,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
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

export async function stageSidecar(options: { skipBuild?: boolean; dev?: boolean } = {}) {
  const target = sidecarTarget(process.platform, process.arch)

  if (!options.skipBuild) await runBuild(options.dev === true)
  const source = sourceBinary(target.platform, target.architecture)
  await verifyBinary(source)
  await mkdir(binariesRoot, { recursive: true })

  const destination = resolve(binariesRoot, sidecarName(target.platform, target.architecture))
  await copyFile(source, destination)
  if (target.platform === "darwin") await chmod(destination, 0o755)
  return destination
}

if (import.meta.main) {
  const destination = await stageSidecar({
    skipBuild: Bun.argv.includes("--skip-build"),
    dev: Bun.argv.includes("--dev"),
  })
  console.log(`Staged JYYCode sidecar: ${destination}`)
}
