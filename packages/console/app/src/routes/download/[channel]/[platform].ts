import type { APIEvent } from "@solidjs/start"
import type { DownloadPlatform } from "../types"

const prodAssetNames: Record<string, string> = {
  "darwin-aarch64-dmg": "jyycode-desktop-mac-arm64.dmg",
  "darwin-x64-dmg": "jyycode-desktop-mac-x64.dmg",
  "windows-x64-nsis": "jyycode-desktop-win-x64.exe",
  "linux-x64-deb": "jyycode-desktop-linux-amd64.deb",
  "linux-x64-appimage": "jyycode-desktop-linux-x86_64.AppImage",
  "linux-x64-rpm": "jyycode-desktop-linux-x86_64.rpm",
} satisfies Record<DownloadPlatform, string>

const betaAssetNames: Record<string, string> = {
  "darwin-aarch64-dmg": "jyycode-desktop-mac-arm64.dmg",
  "darwin-x64-dmg": "jyycode-desktop-mac-x64.dmg",
  "windows-x64-nsis": "jyycode-desktop-win-x64.exe",
  "linux-x64-deb": "jyycode-desktop-linux-amd64.deb",
  "linux-x64-appimage": "jyycode-desktop-linux-x86_64.AppImage",
  "linux-x64-rpm": "jyycode-desktop-linux-x86_64.rpm",
} satisfies Record<DownloadPlatform, string>

// Doing this on the server lets us preserve the original name for platforms we don't care to rename for
const downloadNames: Record<string, string> = {
  "darwin-aarch64-dmg": "JYYCode Desktop.dmg",
  "darwin-x64-dmg": "JYYCode Desktop.dmg",
  "windows-x64-nsis": "JYYCode Desktop Installer.exe",
} satisfies { [K in DownloadPlatform]?: string }

export async function GET({ params: { platform, channel } }: APIEvent) {
  const assetName = channel === "stable" ? prodAssetNames[platform] : betaAssetNames[platform]
  if (!assetName) return new Response(null, { status: 404 })

  const resp = await fetch(
    `https://github.com/anomalyco/${channel === "stable" ? "jyycode" : "jyycode-beta"}/releases/latest/download/${assetName}`,
  )

  const downloadName = downloadNames[platform]

  const headers = new Headers(resp.headers)
  if (downloadName) headers.set("content-disposition", `attachment; filename="${downloadName}"`)

  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers })
}
