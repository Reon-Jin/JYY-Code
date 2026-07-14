export type ModelRef = {
  providerID: string
  modelID: string
}

export type StoredModelState = {
  model: Record<string, ModelRef>
  recent: ModelRef[]
  favorite: ModelRef[]
  variant: Record<string, string | undefined>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function modelRef(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) return
  if (typeof value.providerID !== "string" || typeof value.modelID !== "string") return
  return { providerID: value.providerID, modelID: value.modelID }
}

function modelRefs(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const parsed = modelRef(item)
    return parsed ? [parsed] : []
  })
}

export function decodeModelState(value: unknown): StoredModelState {
  const input = isRecord(value) ? value : {}
  const model = isRecord(input.model)
    ? Object.fromEntries(
        Object.entries(input.model).flatMap(([agent, entry]) => {
          const parsed = modelRef(entry)
          return parsed ? [[agent, parsed] as const] : []
        }),
      )
    : {}
  const variant = isRecord(input.variant)
    ? Object.fromEntries(
        Object.entries(input.variant).flatMap(([key, entry]) =>
          typeof entry === "string" || entry === undefined ? [[key, entry] as const] : [],
        ),
      )
    : {}
  return {
    model,
    recent: modelRefs(input.recent),
    favorite: modelRefs(input.favorite),
    variant,
  }
}

export function encodeModelState(state: StoredModelState): StoredModelState {
  return decodeModelState(state)
}
