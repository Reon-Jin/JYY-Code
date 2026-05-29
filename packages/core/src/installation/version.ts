declare global {
  const JYYCODE_VERSION: string
  const JYYCODE_CHANNEL: string
}

export const InstallationVersion = typeof JYYCODE_VERSION === "string" ? JYYCODE_VERSION : "local"
export const InstallationChannel = typeof JYYCODE_CHANNEL === "string" ? JYYCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
