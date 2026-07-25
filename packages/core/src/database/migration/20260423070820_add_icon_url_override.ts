import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const statements = ["[object Object]"] as const

export default {
  id: "20260423070820_add_icon_url_override",
  up(tx) {
    return Effect.forEach(statements, (statement) => tx.run(statement), { discard: true })
  },
} satisfies DatabaseMigration.Migration
