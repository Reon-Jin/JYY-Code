import crypto from "node:crypto"
import { decodeStoredJSONRow, type CorruptSessionRow } from "./row-decoder"

export type RepairInputRow = {
  readonly table: "message" | "part"
  readonly id: string
  readonly data: unknown
}

export type RepairPlan = {
  readonly sourceSessionID: string
  readonly validRows: readonly RepairInputRow[]
  readonly corruptRows: readonly CorruptSessionRow[]
  readonly placeholders: readonly {
    readonly table: "message" | "part"
    readonly sourceID: string
    readonly digest: string
  }[]
}

/** Build a copy-only repair plan. It never mutates the source database. */
export function planSessionRepair(input: {
  readonly sourceSessionID: string
  readonly rows: readonly RepairInputRow[]
  readonly decode?: (table: RepairInputRow["table"], value: unknown) => unknown
}): RepairPlan {
  const validRows: RepairInputRow[] = []
  const corruptRows: CorruptSessionRow[] = []
  for (const row of input.rows) {
    const result = decodeStoredJSONRow({
      table: row.table,
      id: row.id,
      data: row.data,
      decode: (value) => input.decode?.(row.table, value) ?? value,
    })
    if ("value" in result) validRows.push(row)
    else corruptRows.push(result.error)
  }
  return {
    sourceSessionID: input.sourceSessionID,
    validRows,
    corruptRows,
    placeholders: corruptRows.map((row) => ({
      table: row.table,
      sourceID: row.id,
      digest: row.digest,
    })),
  }
}

export function repairPlaceholder(row: CorruptSessionRow) {
  return {
    type: "repair-placeholder" as const,
    sourceID: row.id,
    table: row.table,
    digest: row.digest,
    size: row.size,
    reason: row.reason,
    repairID: crypto.createHash("sha256").update(`${row.table}:${row.id}:${row.digest}`).digest("hex").slice(0, 16),
  }
}
