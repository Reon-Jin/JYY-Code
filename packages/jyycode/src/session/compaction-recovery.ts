import { ExecutionBudget, resolveExecutionBudget } from "../execution/budget"
import { Deadline } from "../execution/deadline"
import {
  measureEffectiveContext,
  sourceHighWatermark,
  type ContextMeasure,
  type SourceHighWatermark,
} from "./compaction-checkpoint"

export type RecoveryPage<T> = {
  readonly items: readonly T[]
  readonly next?: string
}

export type RecoveryChunk<T> = {
  readonly index: number
  readonly items: readonly T[]
  readonly sourceHighWatermark: SourceHighWatermark
  readonly measure: ContextMeasure
}

export type RecoveryPlan<T> = {
  readonly chunks: readonly RecoveryChunk<T>[]
  readonly sourceHighWatermark: SourceHighWatermark
  readonly measure: ContextMeasure
  readonly pages: number
  readonly truncated: boolean
}

export type PagedRecoveryOptions = {
  readonly pageSize?: number
  readonly maxChunks?: number
  readonly budget?: ExecutionBudget
  readonly deadline?: Deadline
}

const DEFAULT_PAGE_SIZE = 50

function normalizePageSize(value: number | undefined) {
  if (value === undefined) return DEFAULT_PAGE_SIZE
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("pageSize must be a positive integer")
  return value
}

/**
 * Build a recovery plan from an already paged source. The input is copied into
 * bounded chunks, so callers can create a new session without mutating the
 * original history.
 */
export function planRecovery<T>(items: readonly T[], options: PagedRecoveryOptions = {}): RecoveryPlan<T> {
  const pageSize = normalizePageSize(options.pageSize)
  const budget = options.budget ?? resolveExecutionBudget({ operationClass: "generic_tool" })
  const deadline = options.deadline ?? budget.deadline
  const chunks: RecoveryChunk<T>[] = []
  let cursor = 0
  let truncated = false
  while (cursor < items.length) {
    if (deadline.expired()) {
      truncated = true
      break
    }
    if (chunks.length >= (options.maxChunks ?? Number.POSITIVE_INFINITY)) {
      truncated = true
      break
    }
    const page = items.slice(cursor, cursor + pageSize)
    if (!page.length) break
    chunks.push({
      index: chunks.length,
      items: structuredClone(page),
      sourceHighWatermark: sourceHighWatermark(page as ReadonlyArray<{ info?: { id?: string; role?: string; time?: { created?: number }; summary?: unknown }; parts?: ReadonlyArray<{ type?: string }> }>),
      measure: measureEffectiveContext(page),
    })
    cursor += page.length
  }
  return {
    chunks,
    sourceHighWatermark: sourceHighWatermark(items as ReadonlyArray<{ info?: { id?: string; role?: string; time?: { created?: number }; summary?: unknown }; parts?: ReadonlyArray<{ type?: string }> }>),
    measure: measureEffectiveContext(items.slice(0, cursor)),
    pages: chunks.length,
    truncated,
  }
}

/** Read an unbounded history through a cursor/page API under one bounded budget. */
export async function recoverPaged<T>(
  readPage: (cursor?: string) => Promise<RecoveryPage<T>>,
  options: PagedRecoveryOptions = {},
): Promise<RecoveryPlan<T>> {
  const pageSize = normalizePageSize(options.pageSize)
  const budget = options.budget ?? resolveExecutionBudget({ operationClass: "generic_tool" })
  const deadline = options.deadline ?? budget.deadline
  const items: T[] = []
  let cursor: string | undefined
  let truncated = false
  while (true) {
    if (deadline.expired()) {
      truncated = true
      break
    }
    const page = await readPage(cursor)
    const bounded = page.items.slice(0, pageSize)
    items.push(...bounded)
    if (!page.next || bounded.length === 0) break
    cursor = page.next
  }
  const plan = planRecovery(items, { ...options, pageSize, budget, deadline, maxChunks: options.maxChunks })
  return { ...plan, truncated: plan.truncated || truncated }
}

/** Recovery is copy-only by contract: the callback receives detached chunks. */
export async function createRecoveryCopy<T, A>(
  plan: RecoveryPlan<T>,
  createCopy: (input: { chunks: readonly RecoveryChunk<T>[]; sourceHighWatermark: SourceHighWatermark }) => Promise<A>,
) {
  return createCopy({
    chunks: plan.chunks.map((chunk) => ({ ...chunk, items: structuredClone(chunk.items) })),
    sourceHighWatermark: { ...plan.sourceHighWatermark },
  })
}

export const recoverCompaction = planRecovery
export const recoverSessionInChunks = recoverPaged
