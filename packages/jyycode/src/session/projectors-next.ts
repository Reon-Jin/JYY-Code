import { and, desc, eq } from "@/storage/db"
import type { Database } from "@/storage/db"
import { SessionMessage } from "@jyycode-ai/core/session-message"
import { SessionMessageUpdater } from "@jyycode-ai/core/session-message-updater"
import { SessionEvent } from "@jyycode-ai/core/session-event"
import * as DateTime from "effect/DateTime"
import { SyncEvent } from "@/sync"
import { EventRuntime } from "@/event-runtime"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "./session.sql"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID, SessionID } from "./schema"
import { Schema } from "effect"

const toSyncDefinition = EventRuntime.toSyncDefinition

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
type SessionMessageData = NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>

function encodeDateTimes(value: unknown): unknown {
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value)
  if (Array.isArray(value)) return value.map(encodeDateTimes)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeDateTimes(item)]))
  }
  return value
}

function encodeMessageData(value: unknown): SessionMessageData {
  return encodeDateTimes(value) as SessionMessageData
}

function sqlite(db: Database.TxOrDb, sessionID: SessionID): SessionMessageUpdater.Adapter<void> {
  return {
    getCurrentAssistant() {
      return db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant")))
        .orderBy(desc(SessionMessageTable.id))
        .all()
        .map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
        .find((message): message is SessionMessage.Assistant => message.type === "assistant" && !message.time.completed)
    },
    getCurrentCompaction() {
      return db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
        .orderBy(desc(SessionMessageTable.id))
        .all()
        .map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
        .find((message): message is SessionMessage.Compaction => message.type === "compaction")
    },
    getCurrentShell(callID) {
      return db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "shell")))
        .orderBy(desc(SessionMessageTable.id))
        .all()
        .map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
        .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
    },
    updateAssistant(assistant) {
      const { id, type, ...data } = assistant
      db.update(SessionMessageTable)
        .set({ data: encodeMessageData(data) })
        .where(
          and(
            eq(SessionMessageTable.id, id),
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, type),
          ),
        )
        .run()
    },
    updateCompaction(compaction) {
      const { id, type, ...data } = compaction
      db.update(SessionMessageTable)
        .set({ data: encodeMessageData(data) })
        .where(
          and(
            eq(SessionMessageTable.id, id),
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, type),
          ),
        )
        .run()
    },
    updateShell(shell) {
      const { id, type, ...data } = shell
      db.update(SessionMessageTable)
        .set({ data: encodeMessageData(data) })
        .where(
          and(
            eq(SessionMessageTable.id, id),
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, type),
          ),
        )
        .run()
    },
    appendMessage(message) {
      const { id, type, ...data } = message
      db.insert(SessionMessageTable)
        .values([
          {
            id,
            session_id: sessionID,
            type,
            time_created: DateTime.toEpochMillis(message.time.created),
            data: encodeMessageData(data),
          },
        ])
        .onConflictDoNothing({ target: SessionMessageTable.id })
        .run()
    },
    finish() {},
  }
}

function update(db: Database.TxOrDb, event: SessionEvent.Event) {
  SessionMessageUpdater.update(sqlite(db, event.data.sessionID), event)
}

export default [
  SyncEvent.project(toSyncDefinition(SessionEvent.Legacy.MessageUpdated), (db, data) => {
    const info = data.info as MessageV2.Info
    const { id, sessionID, ...rest } = info
    db.insert(MessageTable)
      .values({ id, session_id: sessionID, time_created: info.time.created, data: rest })
      .onConflictDoUpdate({ target: MessageTable.id, set: { data: rest } })
      .run()
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Legacy.MessageRemoved), (db, data) => {
    db.delete(PartTable)
      .where(and(eq(PartTable.message_id, MessageID.make(data.messageID)), eq(PartTable.session_id, SessionID.make(data.sessionID))))
      .run()
    db.delete(MessageTable)
      .where(and(eq(MessageTable.id, MessageID.make(data.messageID)), eq(MessageTable.session_id, SessionID.make(data.sessionID))))
      .run()
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Legacy.PartUpdated), (db, data) => {
    const part = data.part as MessageV2.Part
    const { id, messageID, sessionID, ...rest } = part
    db.insert(PartTable)
      .values({ id, message_id: messageID, session_id: sessionID, time_created: data.time, data: rest })
      .onConflictDoUpdate({ target: PartTable.id, set: { data: rest } })
      .run()
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Legacy.PartRemoved), (db, data) => {
    db.delete(PartTable)
      .where(and(eq(PartTable.id, PartID.make(data.partID)), eq(PartTable.session_id, SessionID.make(data.sessionID))))
      .run()
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.AgentSwitched), (db, data, event) => {
    db.update(SessionTable)
      .set({
        agent: data.agent,
        time_updated: DateTime.toEpochMillis(data.timestamp),
      })
      .where(eq(SessionTable.id, data.sessionID))
      .run()
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.agent.switched", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.ModelSwitched), (db, data, event) => {
    db.update(SessionTable)
      .set({
        model: data.model,
        time_updated: DateTime.toEpochMillis(data.timestamp),
      })
      .where(eq(SessionTable.id, data.sessionID))
      .run()
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.model.switched", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Prompted), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.prompted", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Synthetic), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.synthetic", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Request.Prepared), () => {}),
  SyncEvent.project(toSyncDefinition(SessionEvent.Shell.Started), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.shell.started", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Shell.Ended), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.shell.ended", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Step.Started), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.step.started", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Step.Ended), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.step.ended", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Step.Failed), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.step.failed", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Text.Started), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.text.started", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Text.Delta), () => {}),
  SyncEvent.project(toSyncDefinition(SessionEvent.Text.Ended), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.text.ended", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Tool.Input.Started), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.input.started", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Tool.Input.Delta), () => {}),
  SyncEvent.project(toSyncDefinition(SessionEvent.Tool.Input.Ended), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.input.ended", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Tool.Called), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.called", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Tool.Progress), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.progress", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Tool.Success), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.success", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Tool.Failed), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.failed", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Reasoning.Started), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.reasoning.started", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Reasoning.Delta), () => {}),
  SyncEvent.project(toSyncDefinition(SessionEvent.Reasoning.Ended), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.reasoning.ended", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Retried), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.retried", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Compaction.Started), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.compaction.started", data })
  }),
  SyncEvent.project(toSyncDefinition(SessionEvent.Compaction.Delta), () => {}),
  SyncEvent.project(toSyncDefinition(SessionEvent.Compaction.Ended), (db, data, event) => {
    update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.compaction.ended", data })
  }),
]
