/**
 * Build pipeline optimization utilities.
 *
 * Provides:
 * 1. Dead code elimination hints via feature flag patterns
 * 2. Bundle chunk size analysis
 * 3. Import cost estimation for critical paths
 *
 * Ported from claudecode's build.ts and scripts/defines.ts patterns.
 */

/** Feature flags that control build-time dead code elimination. */
export const BUILD_FEATURE_FLAGS = {
  SKILL_SEARCH: "JYYCODE_SKILL_SEARCH",
  TOOL_SEARCH: "JYYCODE_TOOL_SEARCH",
  SKILL_LEARNING: "JYYCODE_SKILL_LEARNING",
  PROACTIVE_MODE: "JYYCODE_PROACTIVE_MODE",
  MICRO_COMPACT: "JYYCODE_MICRO_COMPACT",
  REACTIVE_COMPACT: "JYYCODE_REACTIVE_COMPACT",
  COST_TRACKING: "JYYCODE_COST_TRACKING",
  DAEMON_MODE: "JYYCODE_DAEMON_MODE",
  LANGFUSE: "JYYCODE_LANGFUSE",
  BUILD_OPTIMIZATION: "JYYCODE_BUILD_OPTIMIZATION",
} as const

/**
 * Conditional require helper for build-time dead code elimination.
 *
 * Usage:
 *   const module = featureRequire('JYYCODE_SKILL_SEARCH',
 *     () => require('./skill/search'),
 *     () => null
 *   )
 *
 * When using Bun.build with `define`, the compiler can eliminate
 * branches where the flag is known to be false.
 */
export function featureRequire<T>(
  flag: string,
  enabled: () => T,
  disabled: () => T,
): T {
  // At runtime, check the environment variable.
  // At build time, Bun can inline the define and DCE the branch.
  if (process.env[flag] === "1") {
    return enabled()
  }
  return disabled()
}

/**
 * Import cost estimates for key modules (in approximate KB).
 * Used to guide code splitting decisions.
 */
export const MODULE_SIZES: Record<string, number> = {
  "effect": 450,
  "@effect/platform-node": 180,
  "yargs": 120,
  "drizzle-orm": 200,
  "solid-js": 80,
  "@jyycode-ai/core": 150,
  "@jyycode-ai/llm": 100,
}

/**
 * Check if a module is in the critical startup path.
 * Modules in the critical path should be as small as possible.
 */
export function isCriticalPath(moduleName: string): boolean {
  const criticalPaths = [
    "index.ts",
    "cli/bootstrap",
    "config/config",
    "effect/runtime-flags",
  ]
  return criticalPaths.some((p) => moduleName.includes(p))
}

/**
 * Suggest code splitting opportunities based on module size.
 */
export function suggestSplitting(
  modules: { name: string; size: number }[],
): { module: string; reason: string }[] {
  const suggestions: { module: string; reason: string }[] = []

  for (const mod of modules) {
    if (mod.size > 500 && !isCriticalPath(mod.name)) {
      suggestions.push({
        module: mod.name,
        reason: `Module is ${mod.size}KB — consider lazy loading via dynamic import()`,
      })
    }
  }

  return suggestions
}

/**
 * Late-binding require cache for modules that should be loaded only when needed.
 * Reduces initial bundle parse time by deferring non-critical modules.
 */
const lateBindingCache = new Map<string, unknown>()

export function lateRequire<T>(modulePath: string): T {
  if (lateBindingCache.has(modulePath)) {
    return lateBindingCache.get(modulePath) as T
  }
  // This will be replaced by the bundler with actual require
  const mod = require(modulePath) as T
  lateBindingCache.set(modulePath, mod)
  return mod
}
