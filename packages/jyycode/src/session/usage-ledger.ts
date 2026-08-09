export type TokenUsage = {
  readonly total?: number
  readonly input?: number
  readonly output?: number
  readonly reasoning?: number
  readonly cache?: {
    readonly read?: number
    readonly write?: number
  }
}

export type NormalizedTokenUsage = {
  readonly total: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

export type LedgerResult = {
  readonly context: NormalizedTokenUsage
  readonly billing: NormalizedTokenUsage
  readonly cost: number
  readonly duplicate: boolean
}

const EMPTY: NormalizedTokenUsage = {
  total: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

function safe(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function normalize(input: TokenUsage | undefined): NormalizedTokenUsage {
  const output = safe(input?.output)
  const reasoning = safe(input?.reasoning)
  const normalized = {
    input: safe(input?.input),
    output,
    reasoning,
    cache: {
      read: safe(input?.cache?.read),
      write: safe(input?.cache?.write),
    },
  }
  return { ...normalized, total: totalOf(normalized) }
}

function totalOf(input: Omit<NormalizedTokenUsage, "total">): number {
  return input.input + input.output + input.reasoning + input.cache.read + input.cache.write
}

function add(left: NormalizedTokenUsage, right: NormalizedTokenUsage): NormalizedTokenUsage {
  const result = {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cache: {
      read: left.cache.read + right.cache.read,
      write: left.cache.write + right.cache.write,
    },
  }
  return { ...result, total: totalOf(result) }
}

export class UsageLedger {
  private readonly appliedSteps = new Set<number>()
  private billingState: NormalizedTokenUsage = { ...EMPTY, cache: { ...EMPTY.cache } }
  private contextState: NormalizedTokenUsage = { ...EMPTY, cache: { ...EMPTY.cache } }
  private costState = 0

  applyStep(stepIndex: number, usage: TokenUsage | undefined, cost = 0): LedgerResult {
    if (!Number.isSafeInteger(stepIndex) || stepIndex < 0) {
      throw new Error("usage ledger stepIndex must be a non-negative integer")
    }
    if (this.appliedSteps.has(stepIndex)) return this.snapshot(true)
    this.appliedSteps.add(stepIndex)
    const step = normalize(usage)
    this.billingState = add(this.billingState, step)
    // Input and cache-read describe the current model request. Generated
    // output, reasoning, and cache writes remain cumulative for the turn.
    const contextBase = {
      input: step.input,
      output: this.contextState.output + step.output,
      reasoning: this.contextState.reasoning + step.reasoning,
      cache: {
        read: step.cache.read,
        write: this.contextState.cache.write + step.cache.write,
      },
    }
    this.contextState = { ...contextBase, total: totalOf(contextBase) }
    this.costState += safe(cost)
    return this.snapshot(false)
  }

  context(): NormalizedTokenUsage {
    return this.clone(this.contextState)
  }

  billing(): NormalizedTokenUsage {
    return this.clone(this.billingState)
  }

  cost(): number {
    return this.costState
  }

  private snapshot(duplicate: boolean): LedgerResult {
    return {
      context: this.context(),
      billing: this.billing(),
      cost: this.costState,
      duplicate,
    }
  }

  private clone(value: NormalizedTokenUsage): NormalizedTokenUsage {
    return { ...value, cache: { ...value.cache } }
  }
}

export function createUsageLedger() {
  return new UsageLedger()
}
