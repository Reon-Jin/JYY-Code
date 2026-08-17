import { Deadline, type MonotonicClock } from "./deadline"

export type OperationClass =
  | "foreground_shell"
  | "generic_tool"
  | "plugin_hook"
  | "background_process"
  | "git_local"
  | "git_network"
  | "mcp_idle"
  | "mcp_total"
  | "child_agent"
  | "workspace_cleanup"

export type BudgetLimits = {
  readonly defaultMs: number
  readonly hardCapMs: number
  readonly graceMs: number
}

export const DEFAULT_BUDGETS: Readonly<Record<OperationClass, BudgetLimits>> = {
  foreground_shell: { defaultMs: 120_000, hardCapMs: 600_000, graceMs: 3_000 },
  generic_tool: { defaultMs: 120_000, hardCapMs: 300_000, graceMs: 3_000 },
  plugin_hook: { defaultMs: 30_000, hardCapMs: 60_000, graceMs: 1_000 },
  background_process: { defaultMs: 600_000, hardCapMs: 3_600_000, graceMs: 5_000 },
  git_local: { defaultMs: 60_000, hardCapMs: 300_000, graceMs: 3_000 },
  git_network: { defaultMs: 300_000, hardCapMs: 900_000, graceMs: 5_000 },
  mcp_idle: { defaultMs: 60_000, hardCapMs: 120_000, graceMs: 3_000 },
  mcp_total: { defaultMs: 300_000, hardCapMs: 600_000, graceMs: 3_000 },
  child_agent: { defaultMs: 1_800_000, hardCapMs: 3_600_000, graceMs: 15_000 },
  workspace_cleanup: { defaultMs: 5_000, hardCapMs: 30_000, graceMs: 0 },
}

export class ExecutionBudgetError extends Error {
  readonly code = "INVALID_EXECUTION_BUDGET"

  constructor(message: string) {
    super(message)
    this.name = "ExecutionBudgetError"
  }
}

export type BudgetConfig = Partial<Record<OperationClass, Partial<BudgetLimits>>>

function assertDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new ExecutionBudgetError(`${label} must be finite and non-negative`)
  return value
}

function limitsFor(operationClass: OperationClass, config?: BudgetConfig): BudgetLimits {
  const base = DEFAULT_BUDGETS[operationClass]
  const override = config?.[operationClass]
  const limits = {
    defaultMs: override?.defaultMs ?? base.defaultMs,
    hardCapMs: override?.hardCapMs ?? base.hardCapMs,
    graceMs: override?.graceMs ?? base.graceMs,
  }
  assertDuration(limits.defaultMs, `${operationClass}.defaultMs`)
  assertDuration(limits.hardCapMs, `${operationClass}.hardCapMs`)
  assertDuration(limits.graceMs, `${operationClass}.graceMs`)
  if (limits.defaultMs > limits.hardCapMs) {
    throw new ExecutionBudgetError(`${operationClass}.defaultMs cannot exceed hardCapMs`)
  }
  return limits
}

export type ResolveBudgetInput = {
  readonly operationClass: OperationClass
  readonly requestedMs?: number
  readonly parent?: ExecutionBudget
  readonly config?: BudgetConfig
  readonly now?: MonotonicClock
}

export type ResolvedBudget = {
  readonly operationClass: OperationClass
  readonly requestedMs: number | undefined
  readonly effectiveMs: number
  readonly hardCapMs: number
  readonly graceMs: number
  readonly deadline: Deadline
}

export class ExecutionBudget {
  readonly operationClass: OperationClass
  readonly requestedMs: number | undefined
  readonly effectiveMs: number
  readonly hardCapMs: number
  readonly graceMs: number
  readonly deadline: Deadline

  constructor(input: ResolvedBudget) {
    this.operationClass = input.operationClass
    this.requestedMs = input.requestedMs
    this.effectiveMs = input.effectiveMs
    this.hardCapMs = input.hardCapMs
    this.graceMs = input.graceMs
    this.deadline = input.deadline
  }

  remaining(): number {
    return this.deadline.remaining()
  }

  expired(): boolean {
    return this.deadline.expired()
  }

  child(operationClass: OperationClass, maxDurationMs?: number, config?: BudgetConfig): ExecutionBudget {
    return resolveExecutionBudget({
      operationClass,
      requestedMs: maxDurationMs,
      parent: this,
      config,
      now: this.deadline.now,
    })
  }
}

export function resolveExecutionBudget(input: ResolveBudgetInput): ExecutionBudget {
  const limits = limitsFor(input.operationClass, input.config)
  const requested = input.requestedMs === undefined ? undefined : assertDuration(input.requestedMs, "requestedMs")
  const requestedOrDefault = requested ?? limits.defaultMs
  const parentRemaining = input.parent?.remaining()
  const effectiveMs = Math.min(requestedOrDefault, limits.hardCapMs, parentRemaining ?? Number.POSITIVE_INFINITY)
  const now = input.now ?? input.parent?.deadline.now
  const deadline = input.parent ? input.parent.deadline.child(effectiveMs) : Deadline.fromDuration(effectiveMs, { now })
  return new ExecutionBudget({
    operationClass: input.operationClass,
    requestedMs: requested,
    effectiveMs,
    hardCapMs: limits.hardCapMs,
    graceMs: limits.graceMs,
    deadline,
  })
}

export function budgetFor(
  operationClass: OperationClass,
  requestedMs?: number,
  parent?: ExecutionBudget,
  config?: BudgetConfig,
): ExecutionBudget {
  return resolveExecutionBudget({ operationClass, requestedMs, parent, config })
}
