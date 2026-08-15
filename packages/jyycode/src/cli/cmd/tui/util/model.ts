import type { PublicProvider } from "@jyycode-ai/sdk/v2"

export function index(list: PublicProvider[] | undefined) {
  return new Map((list ?? []).map((item) => [item.id, item] as const))
}

export function get(
  list: PublicProvider[] | ReadonlyMap<string, PublicProvider> | undefined,
  providerID: string,
  modelID: string,
) {
  const provider =
    list instanceof Map
      ? list.get(providerID)
      : Array.isArray(list)
        ? list.find((item) => item.id === providerID)
        : undefined
  return provider?.models[modelID]
}

export function name(
  list: PublicProvider[] | ReadonlyMap<string, PublicProvider> | undefined,
  providerID: string,
  modelID: string,
) {
  return get(list, providerID, modelID)?.name ?? modelID
}
