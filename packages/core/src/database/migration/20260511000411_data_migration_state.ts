import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const statements = [
  "[object Object]"
] as const

export default {
  id: "20260511000411_data_migration_state",
  up(tx) {
    return Effect.forEach(statements, (statement) => tx.run(statement), { discard: true })
  },
} satisfies DatabaseMigration.Migration

