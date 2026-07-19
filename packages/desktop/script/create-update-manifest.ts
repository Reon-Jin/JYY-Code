import { readFileSync, writeFileSync } from "node:fs"

export type UpdateManifestInput = {
  version: string
  repository: string
  tag: string
  installerName?: string
  signature?: string
  artifacts?: readonly UpdateManifestArtifact[]
  notes: string
  pubDate: string
}

export type UpdateManifestPlatform = "windows-x86_64" | "darwin-aarch64"

export type UpdateManifestArtifact = {
  platform: UpdateManifestPlatform
  artifactName: string
  signature: string
}

export function createUpdateManifest(input: UpdateManifestInput) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) {
    throw new Error(`Invalid version: ${input.version}`)
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.repository)) throw new Error(`Invalid repository: ${input.repository}`)
  if (Number.isNaN(Date.parse(input.pubDate))) throw new Error(`Invalid publication date: ${input.pubDate}`)

  const artifacts =
    input.artifacts ??
    (input.installerName
      ? [
          {
            platform: "windows-x86_64" as const,
            artifactName: input.installerName,
            signature: input.signature ?? "",
          },
        ]
      : [])
  if (!artifacts.length) throw new Error("At least one updater artifact is required")

  const platforms = Object.fromEntries(
    artifacts.map((artifact) => {
      if (!artifact.artifactName) throw new Error(`Artifact name is empty for ${artifact.platform}`)
      if (!artifact.signature.trim()) throw new Error(`Signature is empty for ${artifact.platform}`)
      if (artifact.platform === "windows-x86_64" && !artifact.artifactName.toLowerCase().endsWith(".exe")) {
        throw new Error("Windows updater artifact must be an EXE")
      }
      if (artifact.platform === "darwin-aarch64" && !artifact.artifactName.toLowerCase().endsWith(".tar.gz")) {
        throw new Error("macOS updater artifact must be a tar.gz")
      }
      const url = `https://github.com/${input.repository}/releases/download/${encodeURIComponent(input.tag)}/${encodeURIComponent(artifact.artifactName)}`
      return [artifact.platform, { signature: artifact.signature.trim(), url }]
    }),
  )
  return {
    version: input.version,
    notes: input.notes,
    pub_date: input.pubDate,
    platforms,
  }
}

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

if (import.meta.main) {
  const windowsSignaturePath = process.argv.includes("--signature") ? argument("signature") : undefined
  const windowsInstallerName = process.argv.includes("--installer-name") ? argument("installer-name") : undefined
  const macSignaturePath = process.argv.includes("--mac-signature") ? argument("mac-signature") : undefined
  const macInstallerName = process.argv.includes("--mac-installer-name") ? argument("mac-installer-name") : undefined
  const outputPath = argument("output")
  const artifacts: UpdateManifestArtifact[] = []
  if (windowsSignaturePath && windowsInstallerName) {
    artifacts.push({
      platform: "windows-x86_64",
      artifactName: windowsInstallerName,
      signature: readFileSync(windowsSignaturePath, "utf8"),
    })
  }
  if (macSignaturePath && macInstallerName) {
    artifacts.push({
      platform: "darwin-aarch64",
      artifactName: macInstallerName,
      signature: readFileSync(macSignaturePath, "utf8"),
    })
  }
  if (!artifacts.length) throw new Error("Missing updater artifact arguments")
  const manifest = createUpdateManifest({
    version: argument("version"),
    repository: argument("repository"),
    tag: argument("tag"),
    artifacts,
    notes: argument("notes"),
    pubDate: argument("pub-date"),
  })
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}
