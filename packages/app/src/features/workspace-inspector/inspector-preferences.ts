import { normalizeDirectory } from "../../data/query-keys"

export type InspectorPane = "todo" | "multi-agent" | "changes"
export type InspectorPreferences = { pane?: InspectorPane }

export const defaultInspectorPreferences: InspectorPreferences = { pane: undefined }

const panes = new Set<InspectorPane>(["todo", "multi-agent", "changes"])

function preferenceKey(directory: string) {
  return `jyycode:workspace-inspector:${normalizeDirectory(directory)}`
}

function browserStorage(storage?: Storage) {
  if (storage) return storage
  if (typeof localStorage === "undefined") return undefined
  return localStorage
}

export function loadInspectorPreferences(directory: string, storage?: Storage): InspectorPreferences {
  try {
    const value = browserStorage(storage)?.getItem(preferenceKey(directory))
    if (!value) return { ...defaultInspectorPreferences }
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== "object" || parsed === null) return { ...defaultInspectorPreferences }
    const record = parsed as Record<string, unknown>
    if (typeof record.pane === "string") {
      return panes.has(record.pane as InspectorPane)
        ? { pane: record.pane as InspectorPane }
        : { ...defaultInspectorPreferences }
    }
    if (typeof record.open === "boolean") return { pane: record.open ? "todo" : undefined }
    return { ...defaultInspectorPreferences }
  } catch {
    return { ...defaultInspectorPreferences }
  }
}

export function saveInspectorPreferences(directory: string, preferences: InspectorPreferences, storage?: Storage) {
  try {
    browserStorage(storage)?.setItem(preferenceKey(directory), JSON.stringify({ pane: preferences.pane }))
  } catch {
    // Preference persistence should never block the workspace.
  }
}
