import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const generatedRelativePath = "packages/sdk/js/src/v2/gen"
const requiredFiles = [
  "client.gen.ts",
  "client/client.gen.ts",
  "client/index.ts",
  "client/types.gen.ts",
  "client/utils.gen.ts",
  "core/auth.gen.ts",
  "core/bodySerializer.gen.ts",
  "core/params.gen.ts",
  "core/pathSerializer.gen.ts",
  "core/queryKeySerializer.gen.ts",
  "core/serverSentEvents.gen.ts",
  "core/types.gen.ts",
  "core/utils.gen.ts",
  "sdk.gen.ts",
  "types.gen.ts",
]

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(entryPath)).map((file) => path.join(entry.name, file)))
    else files.push(entry.name)
  }
  return files.sort()
}

async function compareDirectories(expectedDir: string, actualDir: string) {
  const [expectedFiles, actualFiles] = await Promise.all([listFiles(expectedDir), listFiles(actualDir)])
  const expectedSet = new Set(expectedFiles)
  const actualSet = new Set(actualFiles)
  const missing = expectedFiles.filter((file) => !actualSet.has(file))
  const unexpected = actualFiles.filter((file) => !expectedSet.has(file))
  const changed: string[] = []

  for (const file of expectedFiles) {
    if (!actualSet.has(file)) continue
    const [expected, actual] = await Promise.all([
      readFile(path.join(expectedDir, file)),
      readFile(path.join(actualDir, file)),
    ])
    if (!expected.equals(actual)) changed.push(file)
  }

  return { missing, unexpected, changed }
}

export type GeneratedSdkVerification = {
  ok: boolean
  message?: string
}

export async function verifyGeneratedSdkLayout(rootDir = process.cwd()): Promise<GeneratedSdkVerification> {
  const generatedDir = path.join(rootDir, generatedRelativePath)
  const missing: string[] = []
  for (const file of requiredFiles) {
    try {
      await readFile(path.join(generatedDir, file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.push(file)
      else throw error
    }
  }
  const unexpectedArtifacts = ["packages/sdk/js/openapi.json"]
  const unexpected: string[] = []
  for (const file of unexpectedArtifacts) {
    try {
      await readFile(path.join(rootDir, file))
      unexpected.push(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  if (missing.length > 0 || unexpected.length > 0)
    return {
      ok: false,
      message: [
        missing.length > 0 ? `missing generated SDK files: ${missing.join(", ")}` : "",
        unexpected.length > 0 ? `temporary SDK artifacts remain: ${unexpected.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    }

  return { ok: true }
}

export async function verifyGeneratedSdkBuild(rootDir = process.cwd()): Promise<GeneratedSdkVerification> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jyycode-sdk-"))
  const generatedDir = path.join(tempDir, "gen")
  const openapiPath = path.join(tempDir, "openapi.json")
  const buildScript = path.join(rootDir, "packages/sdk/js/script/build.ts")

  try {
    const subprocess = Bun.spawn([process.execPath, "run", buildScript], {
      cwd: rootDir,
      env: {
        ...process.env,
        JYYCODE_SDK_GENERATED_DIR: generatedDir,
        JYYCODE_SDK_OPENAPI_PATH: openapiPath,
        JYYCODE_SDK_VERIFY_ONLY: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ])
    if (exitCode !== 0)
      return {
        ok: false,
        message: `generated SDK build failed (exit ${exitCode}):\n${stderr || stdout}`,
      }

    const differences = await compareDirectories(path.join(rootDir, generatedRelativePath), generatedDir)
    const details = [
      differences.missing.length > 0 ? `missing from tracked output: ${differences.missing.join(", ")}` : "",
      differences.unexpected.length > 0 ? `obsolete tracked output: ${differences.unexpected.join(", ")}` : "",
      differences.changed.length > 0 ? `changed generated files: ${differences.changed.join(", ")}` : "",
    ].filter(Boolean)
    return details.length === 0
      ? { ok: true }
      : { ok: false, message: `generated SDK output is stale; ${details.join("; ")}` }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const rootDir = process.cwd()
  const layout = await verifyGeneratedSdkLayout(rootDir)
  const build = process.argv.includes("--check") ? await verifyGeneratedSdkBuild(rootDir) : { ok: true as const }
  const result = layout.ok && build.ok ? { ok: true } : { ok: false, message: layout.message ?? build.message }
  if (!result.ok) {
    console.error(result.message)
    process.exitCode = 1
  } else {
    console.log("Generated SDK layout and output are clean.")
  }
}
