import { readFileSync, writeFileSync } from "node:fs"

export type UpdateManifestInput = {
  version: string
  repository: string
  tag: string
  installerName: string
  signature: string
  notes: string
  pubDate: string
}

export function createUpdateManifest(input: UpdateManifestInput) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) {
    throw new Error(`Invalid version: ${input.version}`)
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.repository)) throw new Error(`Invalid repository: ${input.repository}`)
  if (!input.signature.trim()) throw new Error("Signature is empty")
  if (!input.installerName.toLowerCase().endsWith(".exe")) throw new Error("Updater installer must be an EXE")
  if (Number.isNaN(Date.parse(input.pubDate))) throw new Error(`Invalid publication date: ${input.pubDate}`)

  const url = `https://github.com/${input.repository}/releases/download/${encodeURIComponent(input.tag)}/${encodeURIComponent(input.installerName)}`
  return {
    version: input.version,
    notes: input.notes,
    pub_date: input.pubDate,
    platforms: {
      "windows-x86_64": {
        signature: input.signature.trim(),
        url,
      },
    },
  }
}

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

if (import.meta.main) {
  const signaturePath = argument("signature")
  const outputPath = argument("output")
  const manifest = createUpdateManifest({
    version: argument("version"),
    repository: argument("repository"),
    tag: argument("tag"),
    installerName: argument("installer-name"),
    signature: readFileSync(signaturePath, "utf8"),
    notes: argument("notes"),
    pubDate: argument("pub-date"),
  })
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}
