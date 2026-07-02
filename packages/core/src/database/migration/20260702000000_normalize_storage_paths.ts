import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260702000000_normalize_storage_paths",
  up(tx) {
    return Effect.gen(function* () {
      const collision = yield* tx.get<{ normalized: string }>(sql`
        SELECT lower(replace(worktree, char(92), '/')) AS normalized
        FROM project
        WHERE instr(worktree, char(92)) > 0 OR worktree GLOB '[A-Za-z]:/*'
        GROUP BY lower(replace(worktree, char(92), '/'))
        HAVING count(*) > 1
        LIMIT 1
      `)
      if (collision) return yield* Effect.fail(new Error(`Path normalization collision: ${collision.normalized}`))

      yield* tx.run(
        sql`UPDATE project SET worktree = replace(worktree, char(92), '/') WHERE instr(worktree, char(92)) > 0`,
      )
      yield* tx.run(sql`
        UPDATE project
        SET sandboxes = replace(sandboxes, char(92) || char(92), '/')
        WHERE instr(sandboxes, char(92)) > 0
      `)
      yield* tx.run(
        sql`UPDATE session SET directory = replace(directory, char(92), '/') WHERE instr(directory, char(92)) > 0`,
      )
      yield* tx.run(
        sql`UPDATE session SET path = replace(path, char(92), '/') WHERE path IS NOT NULL AND instr(path, char(92)) > 0`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
