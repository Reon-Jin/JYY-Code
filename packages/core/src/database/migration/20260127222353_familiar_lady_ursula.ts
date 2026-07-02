import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const statements = [
  "[object Object]"
] as const

export default {
  id: "20260127222353_familiar_lady_ursula",
  up(tx) {
    return Effect.forEach(statements, (statement) => tx.run(statement), { discard: true })
  },
} satisfies DatabaseMigration.Migration

