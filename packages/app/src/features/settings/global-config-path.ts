export function globalConfigPath(directory: string) {
  const separator = directory.includes("\\") ? "\\" : "/"
  return `${directory.replace(/[\\/]+$/, "")}${separator}jyycode.jsonc`
}
