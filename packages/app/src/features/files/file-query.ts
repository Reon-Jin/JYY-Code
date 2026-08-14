import type { FileContent, FileContentWrite, FileContentWriteResult, FileNode } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import type { DesktopClient } from "../../data/sdk"
import { keys, normalizeRelativePath } from "../../data/query-keys"

type FileClient = Pick<DesktopClient, "file">

export type FileQueryScope = {
  directory: string
  workspaceID?: string
  sessionID?: string
  relativePath?: string
}

export type FileQueryInput = FileQueryScope & {
  client: FileClient
  signal?: AbortSignal
  live?: boolean
}

export type FileWriteInput = Pick<FileContentWrite, "path" | "content" | "encoding" | "revision">

const requestOptions = (signal?: AbortSignal) =>
  signal ? ({ throwOnError: true, signal } as const) : ({ throwOnError: true } as const)

function requestPath(relativePath?: string) {
  return normalizeRelativePath(relativePath)
}

function requestScope(input: FileQueryScope, relativePath?: string) {
  return {
    directory: input.directory,
    ...(input.workspaceID ? { workspace: input.workspaceID } : {}),
    path: requestPath(relativePath),
  }
}

export async function loadFileList(input: FileQueryInput): Promise<FileNode[]> {
  const result = await input.client.file.list(requestScope(input, input.relativePath), requestOptions(input.signal))
  return result.data ?? []
}

export function fileListQueryOptions(input: FileQueryInput) {
  return {
    queryKey: keys.fileList(input.directory, input.workspaceID, input.sessionID, input.relativePath),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadFileList({ ...input, signal }),
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  } as const
}

export async function loadFileContent(input: FileQueryInput): Promise<FileContent> {
  const result = await input.client.file.read(requestScope(input, input.relativePath), requestOptions(input.signal))
  if (!result.data) throw new Error("File content response was empty")
  return result.data
}

export function fileContentQueryOptions(input: FileQueryInput) {
  return {
    queryKey: keys.fileContent(input.directory, input.workspaceID, input.sessionID, input.relativePath),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadFileContent({ ...input, signal }),
    // FileWatcher events invalidate this exact query key. Polling the complete
    // file every second turns a passive preview into a continuous disk/CPU load.
    refetchInterval: false,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  } as const
}

export type FileApiInput = FileQueryScope & {
  client: FileClient
  queryClient: QueryClient
}

function parentPath(relativePath: string) {
  const normalized = normalizeRelativePath(relativePath)
  return normalized.slice(0, Math.max(0, normalized.lastIndexOf("/")))
}

export function createFileApi(input: FileApiInput) {
  async function write(value: FileWriteInput, signal?: AbortSignal): Promise<FileContentWriteResult> {
    const result = await input.client.file.write(
      {
        directory: input.directory,
        ...(input.workspaceID ? { workspace: input.workspaceID } : {}),
        fileContentWrite: { ...value, path: requestPath(value.path) },
      },
      requestOptions(signal),
    )
    if (!result.data) throw new Error("File write response was empty")

    const contentKey = keys.fileContent(input.directory, input.workspaceID, input.sessionID, value.path)
    const current = input.queryClient.getQueryData<FileContent>(contentKey)
    if (current) {
      input.queryClient.setQueryData<FileContent>(contentKey, {
        ...current,
        type: "text",
        content: value.content,
        revision: result.data.revision,
        encoding: value.encoding,
        mimeType: undefined,
      })
    }

    await Promise.all([
      input.queryClient.invalidateQueries({
        queryKey: keys.fileList(input.directory, input.workspaceID, input.sessionID, parentPath(value.path)),
        exact: true,
      }),
      input.queryClient.invalidateQueries({
        queryKey: keys.vcsDiff(input.directory, input.workspaceID, input.sessionID, value.path),
        exact: true,
      }),
      input.queryClient.invalidateQueries({
        queryKey: keys.sessionDiff(input.directory, input.workspaceID, input.sessionID),
        exact: true,
      }),
    ])
    return result.data
  }

  return { write }
}
