import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const statements = ["[object Object]"] as const

export default {
  id: "20260501142318_next_venus",
  up(tx) {
    return Effect.forEach(statements, (statement) => tx.run(statement), { discard: true })
  },
} satisfies DatabaseMigration.Migration
