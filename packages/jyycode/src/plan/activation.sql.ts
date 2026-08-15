import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const PlanActivationTable = sqliteTable(
  "plan_activation",
  {
    session_id: text().primaryKey(),
    parent_session_id: text().notNull(),
    task_id: text().notNull(),
    run_id: text().notNull(),
    owner_id: text().notNull(),
    generation: integer().notNull(),
    lease_expires_at: integer().notNull(),
    state: text().notNull(),
    recovery_reason: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("plan_activation_parent_idx").on(table.parent_session_id, table.session_id),
    index("plan_activation_lease_idx").on(table.lease_expires_at, table.state),
    index("plan_activation_owner_idx").on(table.owner_id, table.state),
  ],
)

export * as PlanActivationSql from "./activation.sql"
