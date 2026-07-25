import { normalizeDirectory } from "../../data/query-keys"

export type InspectorPane = "todo" | "multi-agent" | "changes"
export type InspectorPreferences = {
  panes: InspectorPane[]
  ratios: number[]
  width: number
}

export const defaultInspectorPreferences: InspectorPreferences = { panes: [], ratios: [], width: 420 }

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
    if (Array.isArray(record.panes)) {
      const ordered = record.panes.filter(
        (pane, index, values): pane is InspectorPane =>
          typeof pane === "string" && panes.has(pane as InspectorPane) && values.indexOf(pane) === index,
      )
      return {
        panes: ordered,
        ratios: normalizeInspectorRatios(ordered.length, record.ratios),
        width: validWidth(record.width),
      }
    }
    if (typeof record.pane === "string") {
      const pane = panes.has(record.pane as InspectorPane) ? (record.pane as InspectorPane) : undefined
      return pane ? { panes: [pane], ratios: [1], width: validWidth(record.width) } : { ...defaultInspectorPreferences }
    }
    if (typeof record.open === "boolean") {
      return record.open
        ? { panes: ["todo"], ratios: [1], width: validWidth(record.width) }
        : { ...defaultInspectorPreferences }
    }
    return { ...defaultInspectorPreferences }
  } catch {
    return { ...defaultInspectorPreferences }
  }
}

export function saveInspectorPreferences(directory: string, preferences: InspectorPreferences, storage?: Storage) {
  try {
    browserStorage(storage)?.setItem(preferenceKey(directory), JSON.stringify(preferences))
  } catch {
    // Preference persistence should never block the workspace.
  }
}

function validWidth(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(280, value) : defaultInspectorPreferences.width
}

export function normalizeInspectorRatios(count: number, value?: unknown): number[] {
  if (count <= 0) return []
  if (!Array.isArray(value) || value.length !== count) return Array.from({ length: count }, () => 1 / count)
  const ratios = value.map((item) => (typeof item === "number" && Number.isFinite(item) && item > 0 ? item : 0))
  const total = ratios.reduce((sum, ratio) => sum + ratio, 0)
  if (total <= 0) return Array.from({ length: count }, () => 1 / count)
  return ratios.map((ratio) => ratio / total)
}
