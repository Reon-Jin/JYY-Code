import { eq, sql } from "drizzle-orm"
import type { TxOrDb } from "@/storage/db"
import type { MessageV2 } from "./message-v2"
import type { SessionID } from "./schema"
import { PartTable, SessionTable } from "./session.sql"

type Usage = Pick<MessageV2.StepFinishPart, "cost" | "tokens">

export function stepFinishUsage(part: MessageV2.Part | (typeof PartTable.$inferSelect)["data"]): Usage | undefined {
  if (part.type !== "step-finish") return undefined
  if (!("cost" in part) || !("tokens" in part)) return undefined
  return { cost: part.cost, tokens: part.tokens }
}

export function applyUsage(db: TxOrDb, sessionID: SessionID, value: Usage, sign = 1) {
  db.update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
}
