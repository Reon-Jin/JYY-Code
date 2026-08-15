import { access, readdir } from "node:fs/promises"
import { join } from "node:path"

const rootDir = process.cwd()
const generatedDir = join(rootDir, "packages/sdk/js/src/v2/gen")
const requiredFiles = [
  "client.gen.ts",
  "client/index.ts",
  "client/client.gen.ts",
  "client/types.gen.ts",
  "core/types.gen.ts",
  "sdk.gen.ts",
  "types.gen.ts",
]

for (const file of requiredFiles) {
  await access(join(generatedDir, file))
}

const unexpectedArtifacts = ["packages/sdk/js/openapi.json"]
for (const artifact of unexpectedArtifacts) {
  try {
    await access(join(rootDir, artifact))
    throw new Error(`Generated SDK left a temporary artifact in the workspace: ${artifact}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

const generatedEntries = await readdir(generatedDir, { recursive: true })
if (generatedEntries.some((entry) => entry.endsWith(".openapi.json"))) {
  throw new Error("Generated SDK directory contains an unexpected OpenAPI artifact")
}

console.log(`Generated SDK layout is clean (${requiredFiles.length} required files checked).`)
