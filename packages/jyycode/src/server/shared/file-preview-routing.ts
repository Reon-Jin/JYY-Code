export const FILE_PREVIEW_PATH_PREFIX = "/file/preview/"

export type FilePreviewRoute = {
  directory: string
  workspaceID?: string
  authToken: string
  filePath: string
}

function decodeSegment(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

export function parseFilePreviewRoute(url: URL): FilePreviewRoute | undefined {
  if (!url.pathname.startsWith(FILE_PREVIEW_PATH_PREFIX)) return undefined
  const segments = url.pathname.slice(FILE_PREVIEW_PATH_PREFIX.length).split("/")
  if (segments.length < 4) return undefined

  const directory = decodeSegment(segments.shift() ?? "")
  const workspace = decodeSegment(segments.shift() ?? "")
  const authToken = decodeSegment(segments.shift() ?? "")
  const fileSegments = segments.map(decodeSegment)
  if (!directory || workspace === undefined || !authToken || fileSegments.some((segment) => segment === undefined)) {
    return undefined
  }

  const filePath = fileSegments.join("/")
  if (!filePath) return undefined

  return {
    directory,
    workspaceID: workspace === "_" ? undefined : workspace,
    authToken,
    filePath,
  }
}

export function filePreviewPath(input: {
  directory: string
  workspaceID?: string
  authToken: string
  path: string
}) {
  const segments = [
    input.directory,
    input.workspaceID ?? "_",
    input.authToken,
    ...input.path.replaceAll("\\", "/").split("/").filter(Boolean),
  ].map((value) => encodeURIComponent(value))
  return `${FILE_PREVIEW_PATH_PREFIX}${segments.join("/")}`
}
