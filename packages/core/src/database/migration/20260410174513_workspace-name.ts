import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const statements = [
  "[object Object]"
] as const

export default {
  id: "20260410174513_workspace-name",
  up(tx) {
    return Effect.forEach(statements, (statement) => tx.run(statement), { discard: true })
  },
} satisfies DatabaseMigration.Migration

