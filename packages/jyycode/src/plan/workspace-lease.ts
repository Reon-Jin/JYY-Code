import fs from "node:fs"
import path from "node:path"
import { assertRuntimePath, canonicalPath } from "./workspace-path"

export const WORKSPACE_LEASE_SCHEMA_VERSION = 1 as const
export const DEFAULT_WORKSPACE_LEASE_TTL_MS = 2 * 60 * 1_000
export const WORKSPACE_LEASE_HEARTBEAT_MS = 30 * 1_000

export type WorkspaceLease = {
  schema_version: typeof WORKSPACE_LEASE_SCHEMA_VERSION
  workspace_directory: string
  root_session_id: string
  task_id: string
  run_id: string
  session_id: string
  created_at: string
  heartbeat_at: string
  expires_at: string
  terminal_state?: "success" | "cancel" | "failure" | "quarantine"
  retention_until?: string
}

export type WorkspaceLeaseInput = Pick<
  WorkspaceLease,
  "workspace_directory" | "root_session_id" | "task_id" | "run_id" | "session_id"
> & {
  now?: number
  ttlMs?: number
  terminal_state?: WorkspaceLease["terminal_state"]
  retention_until?: string
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
}

function atomicWrite(pathname: string, value: unknown) {
  const temporary = `${pathname}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value), "utf8")
  fs.renameSync(temporary, pathname)
}

export function workspaceLeasePath(workspaceDirectory: string) {
  const resolved = path.resolve(workspaceDirectory)
  return path.join(path.dirname(resolved), `${path.basename(resolved)}.lease.json`)
}

export function canonicalLeaseWorkspace(input: { runtimeRoot: string; workspaceDirectory: string }) {
  return assertRuntimePath({
    runtimeRoot: input.runtimeRoot,
    candidate: input.workspaceDirectory,
    label: "workspace lease directory",
  })
}

export function validateWorkspaceLease(value: unknown): WorkspaceLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace lease must be an object")
  const lease = value as Partial<WorkspaceLease>
  if (lease.schema_version !== WORKSPACE_LEASE_SCHEMA_VERSION) throw new Error("unsupported workspace lease schema")
  for (const field of ["workspace_directory", "root_session_id", "task_id", "run_id", "session_id"] as const) {
    if (!nonEmpty(lease[field])) throw new Error(`workspace lease ${field} is invalid`)
  }
  for (const field of ["created_at", "heartbeat_at", "expires_at"] as const) {
    if (!nonEmpty(lease[field]) || Number.isNaN(Date.parse(lease[field])))
      throw new Error(`workspace lease ${field} is invalid`)
  }
  if (
    lease.terminal_state !== undefined &&
    !["success", "cancel", "failure", "quarantine"].includes(lease.terminal_state)
  )
    throw new Error("workspace lease terminal_state is invalid")
  if (
    lease.retention_until !== undefined &&
    (!nonEmpty(lease.retention_until) || Number.isNaN(Date.parse(lease.retention_until)))
  )
    throw new Error("workspace lease retention_until is invalid")
  return lease as WorkspaceLease
}

export function readWorkspaceLease(pathname: string): WorkspaceLease | undefined {
  if (!fs.existsSync(pathname)) return undefined
  return validateWorkspaceLease(JSON.parse(fs.readFileSync(pathname, "utf8")))
}

export function leaseIsExpired(lease: WorkspaceLease, now = Date.now()) {
  return Date.parse(lease.expires_at) <= now
}

export function leaseIsRetained(lease: WorkspaceLease, now = Date.now()) {
  return lease.retention_until !== undefined && Date.parse(lease.retention_until) > now
}

export class WorkspaceLeaseStore {
  readonly runtimeRoot: string
  readonly ttlMs: number
  readonly now: () => number

  constructor(input: { runtimeRoot: string; ttlMs?: number; now?: () => number }) {
    this.runtimeRoot = path.resolve(input.runtimeRoot)
    this.ttlMs = input.ttlMs ?? DEFAULT_WORKSPACE_LEASE_TTL_MS
    this.now = input.now ?? Date.now
    fs.mkdirSync(this.runtimeRoot, { recursive: true })
  }

  path(workspaceDirectory: string) {
    const canonical = canonicalLeaseWorkspace({ runtimeRoot: this.runtimeRoot, workspaceDirectory })
    const leasePath = workspaceLeasePath(canonical)
    assertRuntimePath({ runtimeRoot: this.runtimeRoot, candidate: leasePath, label: "workspace lease file" })
    return leasePath
  }

  create(input: WorkspaceLeaseInput) {
    const now = input.now ?? this.now()
    const workspaceDirectory = canonicalLeaseWorkspace({
      runtimeRoot: this.runtimeRoot,
      workspaceDirectory: input.workspace_directory,
    })
    const lease: WorkspaceLease = {
      schema_version: WORKSPACE_LEASE_SCHEMA_VERSION,
      workspace_directory: workspaceDirectory,
      root_session_id: input.root_session_id,
      task_id: input.task_id,
      run_id: input.run_id,
      session_id: input.session_id,
      created_at: new Date(now).toISOString(),
      heartbeat_at: new Date(now).toISOString(),
      expires_at: new Date(now + (input.ttlMs ?? this.ttlMs)).toISOString(),
      ...(input.terminal_state ? { terminal_state: input.terminal_state } : {}),
      ...(input.retention_until ? { retention_until: input.retention_until } : {}),
    }
    atomicWrite(this.path(workspaceDirectory), lease)
    return lease
  }

  read(workspaceDirectory: string) {
    return readWorkspaceLease(this.path(workspaceDirectory))
  }

  heartbeat(workspaceDirectory: string, input?: { sessionId?: string; now?: number }) {
    const pathname = this.path(workspaceDirectory)
    const existing = readWorkspaceLease(pathname)
    if (!existing) return undefined
    if (input?.sessionId !== undefined && existing.session_id !== input.sessionId)
      throw new Error("workspace lease session mismatch")
    const now = input?.now ?? this.now()
    const next: WorkspaceLease = {
      ...existing,
      heartbeat_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.ttlMs).toISOString(),
    }
    atomicWrite(pathname, next)
    return next
  }

  remove(workspaceDirectory: string) {
    const pathname = this.path(workspaceDirectory)
    try {
      fs.rmSync(pathname, { force: true })
      return true
    } catch {
      return false
    }
  }
}

export function removeWorkspaceLeaseFile(workspaceDirectory: string) {
  try {
    fs.rmSync(workspaceLeasePath(canonicalPath(workspaceDirectory)), { force: true })
    return true
  } catch {
    return false
  }
}

export * as WorkspaceLeaseModule from "./workspace-lease"
