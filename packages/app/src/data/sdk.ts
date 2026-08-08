import { createJyycodeClient } from "@jyycode-ai/sdk/v2/client"
import type { DesktopBootstrap } from "../platform/types"

export function authorizationHeader(username: string, password: string) {
  return `Basic ${btoa(`${username}:${password}`)}`
}

export function createDesktopClient(input: DesktopBootstrap, directory?: string) {
  return createJyycodeClient({
    baseUrl: input.baseUrl,
    directory,
    headers: { Authorization: authorizationHeader(input.username, input.password) },
  })
}

export function createFileMediaUrl(input: {
  bootstrap: DesktopBootstrap
  directory: string
  path: string
  workspaceID?: string
}) {
  const base = input.bootstrap.baseUrl.replace(/\/+$/, "")
  const url = new URL(`${base}/file/raw`)
  url.searchParams.set("directory", input.directory)
  url.searchParams.set("path", input.path.replaceAll("\\", "/"))
  if (input.workspaceID) url.searchParams.set("workspace", input.workspaceID)
  url.searchParams.set("auth_token", btoa(`${input.bootstrap.username}:${input.bootstrap.password}`))
  return url.toString()
}

export type DesktopClient = ReturnType<typeof createDesktopClient>
