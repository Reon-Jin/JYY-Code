import { createHash } from "node:crypto"
import * as Tool from "./tool"

export type ToolIdentitySource = "builtin" | "plugin" | "mcp" | "plan"

export type ToolIdentity = {
  source: ToolIdentitySource
  sourceID: string
  modelName: string
}

export type IdentifiedToolDef = Tool.Def & { identity: ToolIdentity }

/** Provider-safe base names are stable even when a source uses punctuation. */
export function providerSafeToolName(value: string) {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "_")
  return safe || "tool"
}

export function toolIdentityFor(def: Tool.Def) {
  return (def as Tool.Def & { identity?: ToolIdentity }).identity
}

export function identifyTool<D extends Tool.Def>(def: D, identity: ToolIdentity): D & { identity: ToolIdentity } {
  return Object.assign({ ...def }, { identity })
}

export type ToolIdentityIndexes = {
  bySourceID: Map<string, IdentifiedToolDef[]>
  byModelName: Map<string, IdentifiedToolDef[]>
}

/** Keep both indexes lossless: duplicate registrations remain observable. */
export function indexToolIdentities(defs: readonly Tool.Def[]): ToolIdentityIndexes {
  const bySourceID = new Map<string, IdentifiedToolDef[]>()
  const byModelName = new Map<string, IdentifiedToolDef[]>()
  for (const def of defs) {
    const identity = toolIdentityFor(def)
    if (!identity) continue
    const identified = def as IdentifiedToolDef
    const sourceBucket = bySourceID.get(identity.sourceID) ?? []
    sourceBucket.push(identified)
    bySourceID.set(identity.sourceID, sourceBucket)
    const modelBucket = byModelName.get(identity.modelName) ?? []
    modelBucket.push(identified)
    byModelName.set(identity.modelName, modelBucket)
  }
  return { bySourceID, byModelName }
}

export type ToolNameCollision = {
  modelName: string
  sourceIDs: string[]
  resolvedNames: Record<string, string>
}

export type ResolvedToolNames = {
  names: Map<string, string>
  collisions: ToolNameCollision[]
}

/** Resolve model names by identity, with suffixes independent of registration order. */
export function resolveToolModelNames(identities: readonly ToolIdentity[]): ResolvedToolNames {
  const groups = new Map<string, ToolIdentity[]>()
  for (const identity of identities) {
    const group = groups.get(identity.modelName) ?? []
    group.push(identity)
    groups.set(identity.modelName, group)
  }

  const names = new Map<string, string>()
  const collisions: ToolNameCollision[] = []
  for (const [modelName, group] of groups) {
    const ordered = [...group].sort((a, b) => a.sourceID.localeCompare(b.sourceID))
    if (ordered.length === 1) {
      names.set(ordered[0]!.sourceID, modelName)
      continue
    }

    const resolvedNames: Record<string, string> = {}
    const used = new Set<string>()
    for (const identity of ordered) {
      const digest = createHash("sha256").update(identity.sourceID).digest("hex")
      let resolved = `${modelName}_${digest.slice(0, 8)}`
      let salt = 0
      while (used.has(resolved)) {
        salt++
        resolved = `${modelName}_${createHash("sha256").update(`${identity.sourceID}:${salt}`).digest("hex").slice(0, 8)}`
      }
      used.add(resolved)
      names.set(identity.sourceID, resolved)
      resolvedNames[identity.sourceID] = resolved
    }
    collisions.push({
      modelName,
      sourceIDs: ordered.map((identity) => identity.sourceID),
      resolvedNames,
    })
  }
  return { names, collisions }
}
