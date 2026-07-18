export type DesktopPathStyle = "windows" | "posix"

export function desktopPathStyle(path: string): DesktopPathStyle {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) return "windows"
  return "posix"
}

export function normalizeDirectory(directory: string) {
  if (desktopPathStyle(directory) === "windows") {
    const normalized = directory.replaceAll("/", "\\")
    if (/^[A-Za-z]:\\+$/.test(normalized)) return `${normalized.slice(0, 2).toLocaleLowerCase("en-US")}\\`
    return normalized.replace(/\\+$/, "").toLocaleLowerCase("en-US")
  }
  if (directory === "/") return directory
  return directory.replace(/\/+$/, "")
}

export function directoryName(directory: string) {
  if (desktopPathStyle(directory) === "windows") {
    const normalized = directory.replaceAll("/", "\\").replace(/\\+$/, "")
    return normalized.split("\\").filter(Boolean).at(-1) ?? normalized
  }
  const normalized = directory === "/" ? directory : directory.replace(/\/+$/, "")
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized
}

export function defaultShellOptions(directory: string) {
  return desktopPathStyle(directory) === "windows"
    ? (["pwsh", "powershell", "cmd", "bash"] as const)
    : (["zsh", "bash"] as const)
}
