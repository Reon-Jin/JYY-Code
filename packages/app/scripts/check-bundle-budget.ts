import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

export type BundleAssetKind = "initial" | "workspace" | "file-preview" | "pdf-worker" | "pptx" | "lazy"

const assetsDirectory = resolve(process.cwd(), "dist/assets")
const summaryPath = resolve(process.cwd(), "dist/performance-summary.json")
const thresholds: Record<BundleAssetKind, number> = {
  initial: 400 * 1024,
  workspace: 500 * 1024,
  "file-preview": 900 * 1024,
  "pdf-worker": 1_600 * 1024,
  pptx: 1_200 * 1024,
  lazy: Number.POSITIVE_INFINITY,
}

async function filesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesIn(path)))
    else files.push(path)
  }
  return files
}

function assetName(href: string) {
  return decodeURIComponent(href.split("/").at(-1) ?? href)
}

export function classifyBundleAsset(name: string, initialAssets: ReadonlySet<string>): BundleAssetKind {
  if (initialAssets.has(name)) return "initial"
  if (/pdf\.worker|pdf-worker/iu.test(name)) return "pdf-worker"
  if (/pptx|aiden0z-pptx/iu.test(name)) return "pptx"
  if (/project-workspace/iu.test(name)) return "workspace"
  if (/file-editor|spreadsheet|xlsx|(?:^|[-.])pdf(?:[-.])/iu.test(name)) return "file-preview"
  return "lazy"
}

async function initialAssets() {
  const html = await readFile(resolve(process.cwd(), "dist/index.html"), "utf8")
  const assets = new Set<string>()
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/giu)) {
    const href = match[1]
    if (href?.includes("assets/")) assets.add(assetName(href))
  }
  return assets
}

export async function collectBundleSummary() {
  const initial = await initialAssets()
  const files = (await filesIn(assetsDirectory)).filter((file) => /\.(?:js|mjs|css)$/u.test(file))
  const assets = await Promise.all(
    files.map(async (file) => {
      const name = file.split(/[\\/]/u).at(-1) ?? file
      const bytes = (await stat(file)).size
      const kind = classifyBundleAsset(name, initial)
      return { name, path: relative(process.cwd(), file), bytes, kind, warning: bytes > thresholds[kind] }
    }),
  )
  assets.sort((left, right) => right.bytes - left.bytes)
  return {
    generatedAt: new Date().toISOString(),
    initialAssets: [...initial].sort(),
    initialBytes: assets.filter((asset) => asset.kind === "initial").reduce((sum, asset) => sum + asset.bytes, 0),
    assets,
  }
}

async function run() {
  try {
    const summary = await collectBundleSummary()
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8")
    if (summary.assets.length === 0) {
      console.log("No JavaScript or CSS build assets found in dist/assets")
      return
    }
    console.log("Build asset baseline (initial and lazy assets are reported separately):")
    for (const asset of summary.assets) {
      const warning = asset.warning ? `  [warn > ${(thresholds[asset.kind] / 1024).toFixed(0)} KiB]` : ""
      console.log(
        `${(asset.bytes / 1024).toFixed(2).padStart(9)} KiB  ${asset.kind.padEnd(12)} ${asset.path}${warning}`,
      )
    }
    console.log(`Initial asset total: ${(summary.initialBytes / 1024).toFixed(2)} KiB`)
    if (summary.initialBytes > thresholds.initial) {
      throw new Error(
        `Initial asset budget exceeded: ${(summary.initialBytes / 1024).toFixed(2)} KiB > ${(thresholds.initial / 1024).toFixed(0)} KiB`,
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("Build asset baseline skipped: dist/assets does not exist; run the build first")
      return
    }
    throw error
  }
}

if (import.meta.main) await run()
