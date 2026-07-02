import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { ProjectID } from "./schema"
import { absoluteArrayColumn, directoryColumn } from "@jyycode-ai/core/database/path"

export const ProjectTable = sqliteTable("project", {
  id: text().$type<ProjectID>().primaryKey(),
  worktree: directoryColumn().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  ...Timestamps,
  time_initialized: integer(),
  sandboxes: absoluteArrayColumn().notNull().$type<string[]>(),
  commands: text({ mode: "json" }).$type<{ start?: string }>(),
})
