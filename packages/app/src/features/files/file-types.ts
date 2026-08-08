export type PreviewKind = "code" | "markdown" | "text" | "pdf" | "docx" | "image" | "video" | "audio" | "unsupported"

const codeExtensions = new Set([
  "c",
  "cc",
  "cpp",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "jsx",
  "json",
  "mjs",
  "py",
  "rs",
  "sql",
  "swift",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
])

const markdownExtensions = new Set(["md", "markdown", "mdown", "mkdn", "mdx"])
const textExtensions = new Set(["conf", "csv", "editorconfig", "env", "ini", "log", "properties", "toml"])
const imageExtensions = new Set(["apng", "avif", "bmp", "gif", "heic", "heif", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"])
const videoExtensions = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm", "wmv"])
const audioExtensions = new Set(["aac", "flac", "m4a", "mp3", "oga", "ogg", "wav", "weba", "wma"])
const binaryExtensions = new Set([
  "7z",
  "apk",
  "bin",
  "bz2",
  "class",
  "db",
  "dll",
  "dmg",
  "doc",
  "exe",
  "gz",
  "iso",
  "jar",
  "lib",
  "o",
  "obj",
  "otf",
  "pdf",
  "ppt",
  "rar",
  "so",
  "sqlite",
  "tar",
  "ttf",
  "wasm",
  "woff",
  "woff2",
  "xls",
  "xz",
  "zip",
])

const extension = (file: string) => {
  const name = file.replaceAll("\\", "/").split("/").pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

const pathParts = (file: string) => file.replaceAll("\\", "/").split("/").filter(Boolean)

export function previewKind(file: string): PreviewKind {
  const ext = extension(file)

  if (ext === "md" || markdownExtensions.has(ext)) return "markdown"
  if (codeExtensions.has(ext)) return "code"
  if (textExtensions.has(ext) || !ext) return "text"
  if (ext === "pdf") return "pdf"
  if (ext === "docx") return "docx"
  if (imageExtensions.has(ext)) return "image"
  if (videoExtensions.has(ext)) return "video"
  if (audioExtensions.has(ext)) return "audio"
  if (binaryExtensions.has(ext)) return "unsupported"

  // Unknown extensions are treated as text until the backend identifies them as binary.
  return "text"
}

export function isEditableText(file: string): boolean {
  const kind = previewKind(file)
  return kind === "code" || kind === "markdown" || kind === "text"
}

export function isHiddenFileNode(
  node: string | { name?: string; path: string; type?: "file" | "directory"; ignored?: boolean },
): boolean {
  if (typeof node !== "string" && node.ignored === true) return true
  const file = typeof node === "string" ? node : node.path || node.name || ""
  return pathParts(file).some((part) => part.startsWith(".") && part.length > 1)
}

export function isDeletedChange(change: { status?: string; type?: string } | null | undefined): boolean {
  const status = change?.status ?? change?.type
  return status?.toLowerCase() === "deleted"
}
