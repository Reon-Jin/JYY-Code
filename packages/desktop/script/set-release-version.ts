import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function replaceRequired(source: string, pattern: RegExp, replacement: string, file: string) {
  if (!pattern.test(source)) throw new Error(`Could not find the Desktop version in ${file}`)
  return source.replace(pattern, replacement)
}

export function setDesktopReleaseVersion(version: string, root = process.cwd()) {
  if (!semver.test(version)) throw new Error(`Invalid Desktop version: ${version}`)

  for (const file of ["packages/desktop/package.json", "packages/desktop/src-tauri/tauri.conf.json"]) {
    const path = resolve(root, file)
    const json = JSON.parse(readFileSync(path, "utf8"))
    json.version = version
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`)
  }

  const manifestFile = "packages/desktop/src-tauri/Cargo.toml"
  const manifestPath = resolve(root, manifestFile)
  const manifest = readFileSync(manifestPath, "utf8")
  writeFileSync(manifestPath, replaceRequired(manifest, /^version = "[^"]+"/m, `version = "${version}"`, manifestFile))

  const lockFile = "packages/desktop/src-tauri/Cargo.lock"
  const lockPath = resolve(root, lockFile)
  const lock = readFileSync(lockPath, "utf8")
  writeFileSync(
    lockPath,
    replaceRequired(
      lock,
      /(\[\[package\]\]\r?\nname = "jyycode-desktop"\r?\nversion = ")[^"]+("\r?\n)/,
      `$1${version}$2`,
      lockFile,
    ),
  )
}

if (import.meta.main) {
  setDesktopReleaseVersion(process.argv[2] ?? "")
  console.log(`Desktop release version set to ${process.argv[2]}`)
}
