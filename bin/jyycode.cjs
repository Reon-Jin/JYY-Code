#!/usr/bin/env node

const childProcess = require("child_process")
const fs = require("fs")
const https = require("https")
const os = require("os")
const path = require("path")

const packageRoot = path.resolve(__dirname, "..")
const cacheDir = path.join(packageRoot, "bin")
const repo = process.env.JYYCODE_RELEASE_REPO || "Reon-Jin/JYY-Code"
const explicitBin = process.env.JYYCODE_BIN_PATH

function platformAsset() {
  const archMap = {
    x64: "x64",
    arm64: "arm64",
  }
  const arch = archMap[process.arch]
  if (!arch) {
    throw new Error(`Unsupported architecture: ${process.arch}`)
  }

  if (process.platform === "win32") {
    return {
      asset: `jyycode-windows-${arch}.zip`,
      binary: "jyycode.exe",
      cached: path.join(cacheDir, ".jyycode.exe"),
    }
  }
  if (process.platform === "darwin") {
    return {
      asset: `jyycode-darwin-${arch}.zip`,
      binary: "jyycode",
      cached: path.join(cacheDir, ".jyycode"),
    }
  }
  if (process.platform === "linux") {
    return {
      asset: `jyycode-linux-${arch}.tar.gz`,
      binary: "jyycode",
      cached: path.join(cacheDir, ".jyycode"),
    }
  }
  throw new Error(`Unsupported platform: ${process.platform}`)
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "jyycode-ai",
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
          res.resume()
          if (redirects > 5) {
            reject(new Error("Too many redirects while downloading JYYCode"))
            return
          }
          resolve(request(new URL(res.headers.location, url).toString(), redirects + 1))
          return
        }
        if (res.statusCode !== 200) {
          const chunks = []
          res.on("data", (chunk) => chunks.push(chunk))
          res.on("end", () => {
            reject(new Error(`Download failed (${res.statusCode}): ${Buffer.concat(chunks).toString("utf8")}`))
          })
          return
        }
        resolve(res)
      },
    )
    req.on("error", reject)
  })
}

async function download(url, destination) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true })
  const response = await request(url)
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination)
    response.pipe(file)
    file.on("finish", () => file.close(resolve))
    file.on("error", reject)
  })
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  })
  if (result.error) {
    throw result.error
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status)
  }
}

async function extract(archive, binary, target) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "jyycode-"))
  try {
    if (archive.endsWith(".zip")) {
      if (process.platform === "win32") {
        run("powershell.exe", [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
          archive,
          tmp,
        ])
      } else {
        run("unzip", ["-oq", archive, "-d", tmp])
      }
    } else {
      run("tar", ["-xzf", archive, "-C", tmp])
    }

    const extracted = path.join(tmp, binary)
    if (!fs.existsSync(extracted)) {
      throw new Error(`Release archive did not contain ${binary}`)
    }
    await fs.promises.copyFile(extracted, target)
    if (process.platform !== "win32") {
      await fs.promises.chmod(target, 0o755)
    }
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true })
  }
}

async function ensureBinary() {
  if (explicitBin) {
    return explicitBin
  }

  const { asset, binary, cached } = platformAsset()
  if (fs.existsSync(cached)) {
    return cached
  }

  const archive = path.join(os.tmpdir(), asset)
  const url = `https://github.com/${repo}/releases/latest/download/${asset}`
  console.error(`Downloading JYYCode from ${url}`)
  await download(url, archive)
  await extract(archive, binary, cached)
  await fs.promises.rm(archive, { force: true })
  return cached
}

async function main() {
  const binary = await ensureBinary()
  const child = childProcess.spawn(binary, process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: false,
  })

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal))
  }

  child.on("error", (error) => {
    console.error(error.message)
    process.exit(1)
  })
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
