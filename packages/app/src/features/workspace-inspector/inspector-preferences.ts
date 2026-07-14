import { normalizeDirectory } from "../../data/query-keys"

export type InspectorPreferences = {
  open: boolean
  todoRatio: number
}

export const defaultInspectorPreferences: InspectorPreferences = {
  open: true,
  todoRatio: 0.42,
}

export function clampInspectorRatio(value: number) {
  return Math.min(0.8, Math.max(0.2, value))
}

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
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).open !== "boolean" ||
      typeof (parsed as Record<string, unknown>).todoRatio !== "number" ||
      !Number.isFinite((parsed as Record<string, unknown>).todoRatio)
    ) {
      return { ...defaultInspectorPreferences }
    }
    return {
      open: (parsed as InspectorPreferences).open,
      todoRatio: clampInspectorRatio((parsed as InspectorPreferences).todoRatio),
    }
  } catch {
    return { ...defaultInspectorPreferences }
  }
}

export function saveInspectorPreferences(directory: string, preferences: InspectorPreferences, storage?: Storage) {
  try {
    browserStorage(storage)?.setItem(
      preferenceKey(directory),
      JSON.stringify({
        open: preferences.open,
        todoRatio: clampInspectorRatio(preferences.todoRatio),
      }),
    )
  } catch {
    // Preference persistence should never block the workspace.
  }
}
