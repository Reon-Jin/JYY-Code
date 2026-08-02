import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260802045805_step_blackboard",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`
        CREATE TABLE blackboard_message (
          id text PRIMARY KEY,
          root_session_id text NOT NULL,
          step_id text NOT NULL,
          parent_message_id text,
          author_kind text NOT NULL,
          author_session_id text,
          author_task_id text,
          kind text NOT NULL,
          body text NOT NULL,
          mentions text DEFAULT '[]' NOT NULL,
          attachments text DEFAULT '[]' NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          FOREIGN KEY (root_session_id) REFERENCES session(id) ON DELETE CASCADE
        )
      `)
      yield* tx.run(sql`
        CREATE TABLE blackboard_message_task (
          message_id text NOT NULL,
          task_id text NOT NULL,
          PRIMARY KEY (message_id, task_id),
          FOREIGN KEY (message_id) REFERENCES blackboard_message(id) ON DELETE CASCADE
        )
      `)
      yield* tx.run(sql`
        CREATE TABLE blackboard_read_cursor (
          root_session_id text NOT NULL,
          step_id text NOT NULL,
          participant_key text NOT NULL,
          last_message_id text,
          checked_at integer NOT NULL,
          PRIMARY KEY (root_session_id, step_id, participant_key),
          FOREIGN KEY (root_session_id) REFERENCES session(id) ON DELETE CASCADE
        )
      `)
      yield* tx.run(
        sql`CREATE INDEX blackboard_message_session_step_id_idx ON blackboard_message (root_session_id, step_id, id)`,
      )
      yield* tx.run(sql`CREATE INDEX blackboard_message_parent_idx ON blackboard_message (parent_message_id)`)
      yield* tx.run(sql`CREATE INDEX blackboard_message_task_task_idx ON blackboard_message_task (task_id)`)
    })
  },
} satisfies DatabaseMigration.Migration
