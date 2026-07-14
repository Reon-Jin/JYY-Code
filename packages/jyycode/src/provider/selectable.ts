export function explicitlySelectableProviders<T extends { id: string }>(
  providers: Record<string, T>,
  authenticatedProviderIDs: Iterable<string>,
  configuredProviderIDs: Iterable<string>,
) {
  const explicit = new Set([...authenticatedProviderIDs, ...configuredProviderIDs])
  if (explicit.size === 0) return providers
  return Object.fromEntries(Object.entries(providers).filter(([id]) => explicit.has(id))) as Record<string, T>
}
