declare global {
  const JYYCODE_VERSION: string
  const JYYCODE_CHANNEL: string
}

export const InstallationVersion = typeof JYYCODE_VERSION === "string" ? JYYCODE_VERSION : "local"
export const InstallationChannel = typeof JYYCODE_CHANNEL === "string" ? JYYCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

export function packageDependencyVersion(version: string, local: boolean) {
  if (local || version.startsWith("0.0.0-")) return
  return version
}

export const InstallationPackageVersion = packageDependencyVersion(InstallationVersion, InstallationLocal)
