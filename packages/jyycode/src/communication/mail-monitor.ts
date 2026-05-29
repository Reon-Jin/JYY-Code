import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { SessionPrompt } from "@/session/prompt"
import * as Session from "@/session/session"
import { listGlobal } from "@/session/session"
import { SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { sendMessage } from "@/communication"
import { DEFAULT_EMAIL_TO } from "@/communication/defaults"
import { MailSession } from "./mail-session"
import type { EmailConfigType, EmailHeaders } from "./schema"
import * as Log from "@jyycode-ai/core/util/log"
import { Context, Duration, Effect, Exit, Layer, Scope } from "effect"
import { connect as tlsConnect } from "node:tls"
import { EOL } from "os"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { Global } from "@jyycode-ai/core/global"
import path from "node:path"

const log = Log.create({ service: "mail.monitor" })
const OWNER = DEFAULT_EMAIL_TO

type Mail = {
  uid: string
  from: string
  addresses: string[]
  subject: string
  messageID?: string
  references?: string
  body: string
}

type Pending = {
  id: string
  from: string
  subject: string
  messageID?: string
  references?: string
  body: string
}

type State = {
  started: boolean
  statsDir: string
  statsFile: string
  highWaterUID?: number
  pending: Map<string, Pending>
  queue: Mail[]
  queuedUIDs: Set<string>
  processingUIDs: Set<string>
  processedUIDs: Set<string>
  processing: boolean
  totalProcessed: number
  totalFailed: number
  lastError: string
  lastPollTime: number
  emailSessionID?: string
  activeSessionID?: string
  activeSubject?: string
  activeFrom?: string
  activeStage?: string
  emailSessionPrimed: boolean
}

type EmailStats = {
  started: boolean
  totalProcessed: number
  totalFailed: number
  currentlyProcessing: boolean
  processingCount: number
  processedCount: number
  pendingCount: number
  queueLength: number
  highWaterUID: number
  lastPollTime: number
  lastError: string
  emailSessionID?: string
  activeSessionID?: string
  activeSubject?: string
  activeFrom?: string
  activeStage?: string
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/MailMonitor") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope
    const state = yield* InstanceState.make<State>((ctx) =>
      Effect.gen(function* () {
        const data: State = {
          started: false,
          statsDir: Global.Path.data,
          statsFile: path.join(Global.Path.data, "email-stats.json"),
          pending: new Map(),
          queue: [],
          queuedUIDs: new Set(),
          processingUIDs: new Set(),
          processedUIDs: new Set(),
          processing: false,
          totalProcessed: 0,
          totalFailed: 0,
          lastError: "",
          lastPollTime: 0,
          activeStage: "idle",
          emailSessionPrimed: false,
        }
        yield* Effect.addFinalizer(() => cleanupEmailSession(data))
        return data
      }),
    )

    const writeStats = Effect.fn("MailMonitor.writeStats")(function* () {
      const data = yield* InstanceState.get(state)
      yield* Effect.promise(() =>
        mkdir(data.statsDir, { recursive: true })
          .then(() => writeFile(data.statsFile, JSON.stringify(statsFromState(data), null, 2), "utf8"))
          .catch(() => {}),
      )
    })

    const cleanupEmailSession = Effect.fn("MailMonitor.cleanupEmailSession")(function* (data: State) {
      const sessionIDs = yield* emailSessionIDsToCleanup(data)
      data.started = false
      data.emailSessionID = undefined
      data.activeSessionID = undefined
      data.emailSessionPrimed = false
      data.activeStage = "stopped"
      data.processing = false
      data.queue = []
      data.pending.clear()
      data.queuedUIDs.clear()
      data.processingUIDs.clear()
      yield* removeEmailSessions(sessionIDs)
      yield* Effect.promise(() => unlink(data.statsFile).catch(() => {}))
    })

    const init: Interface["init"] = Effect.fn("MailMonitor.init")(function* () {
      const cfg = yield* config.get()
      if (cfg.communication?.inbox?.enabled !== true) return
      if (!cfg.communication.email) return

      const data = yield* InstanceState.get(state)
      if (data.started) return
      yield* cleanupEmailSession(data)
      data.started = true
      const session = yield* sessions.create({ title: sessionTitle("Email", "JYYCode startup") })
      data.emailSessionID = session.id
      data.activeSessionID = session.id
      data.activeStage = "idle"
      yield* writeStats()

      // Send startup notification FIRST (forked) — don't wait for IMAP
      const owner = ownerCandidates(cfg)
      yield* send(
        cfg.communication.email,
        owner[0] ?? OWNER,
        "JYYCode 已启动",
        [
          "JYYCode 邮件助手已成功启动。",
          "",
          `时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
          `监控邮箱: ${cfg.communication.email.username}`,
          `轮询间隔: ${cfg.communication.inbox.pollSeconds ?? 1} 秒`,
          "",
          "现在你可以通过发送邮件到监控邮箱来与 JYYCode 交互。",
        ].join(EOL),
      ).pipe(
        Effect.catch((error) => Effect.sync(() => log.warn("startup notification failed", { error: String(error) }))),
        Effect.forkIn(scope),
        Effect.asVoid,
      )

      // Start background polling loop (first poll does initial sync)
      yield* loop(Math.max(1, cfg.communication.inbox.pollSeconds ?? 1)).pipe(Effect.forkIn(scope), Effect.asVoid)
    })

    const loop = Effect.fn("MailMonitor.loop")(function* (pollSeconds: number) {
      while (true) {
        yield* poll().pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const data = yield* InstanceState.get(state)
              data.lastError = String(error)
              yield* writeStats()
              log.warn("mail poll failed", { error: String(error) })
            }),
          ),
        )
        yield* Effect.sleep(`${pollSeconds} seconds`)
      }
    })

    const poll = Effect.fn("MailMonitor.poll")(function* () {
      const cfg = yield* config.get()
      const email = cfg.communication?.email
      if (!email || cfg.communication?.inbox?.enabled !== true) return

      const data = yield* InstanceState.get(state)
      data.lastPollTime = Date.now()
      yield* writeStats()
      log.warn("polling", { highWaterUID: data.highWaterUID, queueLen: data.queue.length, processing: data.processing })
      const result = yield* Effect.promise(() => fetchUnread(email, ownerCandidates(cfg), data.highWaterUID)).pipe(
        Effect.timeout(Duration.seconds(30)),
      )
      log.warn("poll done", { fetched: result.mails.length, initMaxUID: result.initialMaxUID })
      if (data.highWaterUID === undefined && result.initialMaxUID !== undefined) {
        data.highWaterUID = result.initialMaxUID
      }
      const fresh = result.mails.filter(
        (mail) =>
          !data.queuedUIDs.has(mail.uid) && !data.processingUIDs.has(mail.uid) && !data.processedUIDs.has(mail.uid),
      )
      data.queue.push(...fresh)
      fresh.forEach((mail) => data.queuedUIDs.add(mail.uid))
      yield* writeStats()
      if (data.queue.length === 0 || data.processing) return

      data.processing = true
      yield* writeStats()
      yield* processQueue(ownerCandidates(cfg)).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Effect.sync(() => {
                data.processing = false
                log.warn("mail processQueue crashed, reset processing", { error: String(exit.cause) })
              })
            : Effect.void,
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    })

    const processQueue = Effect.fn("MailMonitor.processQueue")(function* (owner: string[]) {
      log.warn("processQueue started", { owner, queueLen: (yield* InstanceState.get(state)).queue.length })
      while (true) {
        const data = yield* InstanceState.get(state)
        const mail = data.queue.shift()
        if (!mail) {
          data.processing = false
          data.activeStage = "idle"
          yield* writeStats()
          return
        }
        data.queuedUIDs.delete(mail.uid)
        if (data.processingUIDs.has(mail.uid) || data.processedUIDs.has(mail.uid)) continue
        data.processingUIDs.add(mail.uid)
        yield* writeStats()

        const handled = yield* Effect.gen(function* () {
          const cfg = yield* config.get()
          const email = cfg.communication?.email
          if (!email || cfg.communication?.inbox?.enabled !== true) return false

          log.warn("handling unread mail", { uid: mail.uid, from: mail.from, subject: mail.subject })
          if (!isOwnerMail(mail, owner)) return false
          data.activeFrom = mail.from
          data.activeSubject = mail.subject
          data.activeStage = "handling"
          yield* writeStats()
          yield* handleOwnerMail(email, owner[0] ?? OWNER, mail)
          return true
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              const msg = String(error)
              data.totalFailed++
              data.lastError = msg
              data.activeStage = "failed"
              log.warn("mail handling failed", {
                uid: mail.uid,
                from: mail.from,
                subject: mail.subject,
                error: msg,
              })
              return false
            }),
          ),
        )

        const cfg = yield* config.get()
        if (handled && cfg.communication?.email) {
          yield* Effect.promise(() => markSeen(cfg.communication!.email!, mail.uid)).pipe(
            Effect.catch((error) =>
              Effect.sync(() => log.warn("mail mark seen failed", { uid: mail.uid, error: String(error) })),
            ),
          )
          const numericUID = Number.parseInt(mail.uid, 10)
          if (Number.isFinite(numericUID)) {
            data.highWaterUID = Math.max(data.highWaterUID ?? 0, numericUID)
          }
          data.processedUIDs.add(mail.uid)
          data.totalProcessed++
          data.lastError = ""
          data.activeStage = "done"
        }
        data.processingUIDs.delete(mail.uid)
        yield* writeStats()
      }
    })

    const handleOwnerMail = Effect.fn("MailMonitor.handleOwnerMail")(function* (
      email: EmailConfigType,
      owner: string,
      mail: Mail,
    ) {
      log.warn("handleOwnerMail", { from: mail.from, subject: mail.subject })
      const data = yield* InstanceState.get(state)
      const replyRequest = parseReplyRequest(mail.body)
      if (replyRequest) {
        log.warn("handleOwnerMail reply request", {
          id: replyRequest.id,
          instruction: replyRequest.instruction.slice(0, 80),
        })
        const pending = data.pending.get(replyRequest.id) ?? [...data.pending.values()].at(-1)
        if (pending) {
          const answer = yield* askJyy({
            title: sessionTitle("Reply email", pending.subject),
            from: pending.from,
            subject: pending.subject,
            text: [
              "你是 JYYCode，正在帮助用户处理邮件。",
              "用户要求你回复下面这封外部邮件。请写一封自然、清楚、礼貌的邮件正文，只输出邮件正文。",
              "",
              `外部发件人: ${pending.from}`,
              `外部邮件主题: ${pending.subject}`,
              "",
              "外部邮件正文:",
              pending.body,
              "",
              "用户指令:",
              replyRequest.instruction || mail.body,
            ].join("\n"),
          })
          yield* send(email, pending.from, subjectForReply(pending.subject), answer, replyHeaders(pending))
          data.pending.delete(pending.id)
          yield* send(
            email,
            owner,
            `已回复: ${pending.subject}`,
            `已回复 ${pending.from}.${EOL}${EOL}${answer}`,
            replyHeaders(mail),
          )
          return
        }
      }

      const answer = yield* askJyy({
        title: sessionTitle("Email", mail.subject),
        from: mail.from,
        subject: mail.subject,
        text: ownerMailPrompt(data.emailSessionPrimed, mail.body, owner),
      })
      data.emailSessionPrimed = true
      yield* send(email, owner, subjectForReply(mail.subject), answer, replyHeaders(mail))
    })

    const handleExternalMail = Effect.fn("MailMonitor.handleExternalMail")(function* (
      email: EmailConfigType,
      owner: string,
      mail: Mail,
    ) {
      const data = yield* InstanceState.get(state)
      const id = `mail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      data.pending.set(id, {
        id,
        from: mail.from,
        subject: mail.subject,
        messageID: mail.messageID,
        references: mail.references,
        body: mail.body,
      })
      yield* send(
        email,
        owner,
        `是否需要回复: ${mail.subject || "(无主题)"}`,
        [
          `收到一封来自 ${mail.from} 的邮件。`,
          "",
          `待回复 ID: ${id}`,
          `主题: ${mail.subject || "(无主题)"}`,
          "",
          "邮件正文:",
          mail.body,
          "",
          `如果要回复，请回邮件写: reply ${id}: 你的指令`,
          `也可以中文写: 回复 ${id}: 你的指令`,
          "如果不需要回复，忽略这封通知即可。",
        ].join(EOL),
      )
    })

    const askJyy = Effect.fn("MailMonitor.askJyy")(function* (input: {
      title: string
      from: string
      subject: string
      text: string
    }) {
      log.warn("asking jyy", { preview: input.text.slice(0, 120) })
      const session = yield* getEmailSession(input.title)
      const data = yield* InstanceState.get(state)
      data.emailSessionID = session.id
      data.activeSessionID = session.id
      data.activeFrom = input.from
      data.activeSubject = input.subject
      data.activeStage = "asking"
      yield* writeStats()
      const result = yield* prompt
        .prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: input.text }],
        })
        .pipe(Effect.timeout(Duration.seconds(180)))
      const raw = assistantText(result) || "Received."
      const reply = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim() || "Received."
      log.warn("jyy replied", { preview: reply.slice(0, 120) })
      return reply
    })

    const getEmailSession = Effect.fn("MailMonitor.getEmailSession")(function* (title: string) {
      const data = yield* InstanceState.get(state)
      if (data.emailSessionID) {
        return yield* sessions.get(SessionID.make(data.emailSessionID)).pipe(
          Effect.catch(() =>
            sessions.create({ title }).pipe(
              Effect.tap((session) =>
                Effect.sync(() => {
                  data.emailSessionID = session.id
                  data.emailSessionPrimed = false
                }),
              ),
            ),
          ),
        )
      }
      const session = yield* sessions.create({ title })
      data.emailSessionID = session.id
      data.emailSessionPrimed = false
      return session
    })

    const emailSessionIDsToCleanup = Effect.fn("MailMonitor.emailSessionIDsToCleanup")(function* (data: State) {
      const fromStats = yield* Effect.promise(async () => {
        const raw = await readFile(data.statsFile, "utf8").catch(() => undefined)
        if (!raw) return []
        const value = JSON.parse(raw) as unknown
        if (!value || typeof value !== "object" || Array.isArray(value)) return []
        const stats = value as Record<string, unknown>
        return [stats.emailSessionID, stats.activeSessionID].filter((item): item is string => typeof item === "string")
      }).pipe(Effect.catch(() => Effect.succeed([])))
      const fromMemory = [data.emailSessionID, data.activeSessionID].filter(
        (item): item is string => typeof item === "string",
      )
      const fromSessions = yield* Effect.sync(() =>
        Array.from(listGlobal({ limit: 1000 }))
          .filter((session) => isMailSessionTitle(session.title))
          .map((session) => session.id),
      )
      return [...new Set([...fromMemory, ...fromStats, ...fromSessions])]
    })

    const removeEmailSessions = Effect.fn("MailMonitor.removeEmailSessions")(function* (sessionIDs: string[]) {
      yield* Effect.forEach(
        sessionIDs,
        (sessionID) =>
          sessions
            .remove(SessionID.make(sessionID))
            .pipe(
              Effect.catch((error) =>
                Effect.sync(() => log.warn("email session cleanup failed", { sessionID, error: String(error) })),
              ),
            ),
        { concurrency: "unbounded", discard: true },
      )
    })

    const send = Effect.fn("MailMonitor.send")(function* (
      email: EmailConfigType,
      to: string,
      subject: string,
      body: string,
      headers?: EmailHeaders,
    ) {
      log.warn("sending mail", { to, subject })
      const result = yield* Effect.promise(() =>
        sendMessage({ email }, { channel: "email", to, subject, body, headers }),
      )
      if (!result.success) {
        log.warn("mail send failed", { message: result.message, to })
        throw new Error(result.message)
      }
      log.warn("mail sent ok", { to, subject })
    })

    return Service.of({ init })
  }),
)

function assistantText(message: MessageV2.WithParts) {
  return message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

export function ownerMailPrompt(emailSessionPrimed: boolean, body: string, defaultRecipient = DEFAULT_EMAIL_TO) {
  if (emailSessionPrimed) return body
  return [
    "你是 JYYCode。下面这封邮件来自用户本人，请像持续对话中的助手一样自然回复。",
    `如果用户让你把本机文件“发过来”或“发给我”，默认使用 send_file 通过 email 发到 ${defaultRecipient}，除非用户明确指定其它收件人或渠道。`,
    "",
    body,
  ].join("\n")
}

function statsFromState(data: State): EmailStats {
  return {
    started: data.started,
    totalProcessed: data.totalProcessed,
    totalFailed: data.totalFailed,
    currentlyProcessing: data.processing,
    processingCount: data.processingUIDs.size,
    processedCount: data.totalProcessed,
    pendingCount: data.pending.size,
    queueLength: data.queue.length,
    highWaterUID: data.highWaterUID ?? 0,
    lastPollTime: data.lastPollTime,
    lastError: data.lastError,
    emailSessionID: data.emailSessionID,
    activeSessionID: data.activeSessionID,
    activeSubject: data.activeSubject,
    activeFrom: data.activeFrom,
    activeStage: data.activeStage,
  }
}

function parseReplyRequest(body: string) {
  const match = body.match(/(?:reply|回复)\s+([a-zA-Z0-9_-]+)(?:\s*[:：]\s*([\s\S]*))?/i)
  if (!match) return
  return { id: match[1], instruction: match[2]?.trim() ?? "" }
}

function subjectForReply(subject: string) {
  if (!subject.trim()) return "Re: (no subject)"
  if (/^re:/i.test(subject.trim())) return subject.trim()
  return `Re: ${subject.trim()}`
}

function sessionTitle(prefix: string, subject: string) {
  const value = subject.trim() || "(no subject)"
  return `${prefix}: ${value.slice(0, 80)}`
}

export function isMailSessionTitle(title: string) {
  return MailSession.isMailSessionTitle(title)
}

async function fetchUnread(
  config: EmailConfigType,
  owners: string[] = [],
  highWaterUID?: number,
): Promise<{ mails: Mail[]; initialMaxUID?: number }> {
  const conn = await imapConnect(config)
  try {
    await imapCommand(conn, `LOGIN ${imapQuote(config.username)} ${imapQuote(config.password)}`)
    const selected = await imapCommand(conn, `SELECT ${imapQuote(config.mailbox ?? "INBOX")}`)

    const uidNext = parseUIDNext(selected)
    const foundUIDs = (
      await Promise.all(owners.map((owner) => imapCommand(conn, `UID SEARCH UNSEEN FROM ${imapQuote(owner)}`)))
    ).flatMap(parseSearchUIDs)
    const newUIDs = foundUIDs
      .filter((uid, index) => foundUIDs.indexOf(uid) === index)
      .filter((uid) => highWaterUID === undefined || uid > highWaterUID)
      .toSorted((a, b) => b - a)
      .slice(0, 20)
    log.warn("fetchUnread details", {
      uidNext,
      owners,
      aboveWater: newUIDs.length > 0 ? newUIDs : "none",
    })

    const mails: Mail[] = []
    for (const uid of newUIDs) {
      const raw = await imapCommand(conn, `UID FETCH ${uid} BODY.PEEK[]`, 256_000)
      mails.push({ uid: String(uid), ...parseMail(raw) })
    }
    await imapCommand(conn, "LOGOUT")
    return {
      mails,
      initialMaxUID: uidNext !== undefined ? uidNext - 1 : undefined,
    }
  } finally {
    conn.end()
  }
}

function parseUIDNext(selectResponse: string): number | undefined {
  const match = selectResponse.match(/UIDNEXT\s+(\d+)/i)
  return match ? Number.parseInt(match[1], 10) : undefined
}

function parseSearchUIDs(response: string): number[] {
  const line = response.split(/\r?\n/).find((l) => l.startsWith("* SEARCH "))
  if (!line) return []
  return line
    .slice("* SEARCH ".length)
    .trim()
    .split(/\s+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n))
}

async function markSeen(config: EmailConfigType, uid: string): Promise<void> {
  const conn = await imapConnect(config)
  try {
    await imapCommand(conn, `LOGIN ${imapQuote(config.username)} ${imapQuote(config.password)}`)
    await imapCommand(conn, `SELECT ${imapQuote(config.mailbox ?? "INBOX")}`)
    await imapCommand(conn, `UID STORE ${uid} +FLAGS.SILENT (\\Seen)`)
    await imapCommand(conn, "LOGOUT")
  } finally {
    conn.end()
  }
}

function imapConnect(config: EmailConfigType) {
  return new Promise<ReturnType<typeof tlsConnect>>((resolve, reject) => {
    const host = config.imapHost ?? config.smtpHost.replace(/^smtp\./, "imap.")
    const fail = (error: Error) => {
      clearTimeout(connectTimer)
      conn.removeAllListeners("error")
      conn.end()
      reject(error)
    }
    const connectTimer = setTimeout(() => fail(new Error("IMAP connect timeout")), 15000)
    const conn = tlsConnect({ host, port: config.imapPort ?? 993, servername: host }, () => {
      const onGreeting = (data: Buffer) => {
        conn.off("data", onGreeting)
        conn.off("error", onError)
        clearTimeout(timer)
        clearTimeout(connectTimer)
        resolve(conn)
      }
      const onError = (err: Error) => {
        conn.off("data", onGreeting)
        conn.off("error", onError)
        clearTimeout(timer)
        fail(err)
      }
      const timer = setTimeout(() => {
        conn.off("data", onGreeting)
        conn.off("error", onError)
        clearTimeout(connectTimer)
        resolve(conn)
      }, 5000)
      conn.on("data", onGreeting)
      conn.on("error", onError)
    })
    conn.on("error", fail)
  })
}

function imapCommand(conn: ReturnType<typeof tlsConnect>, command: string, maxBytes = 64_000) {
  return new Promise<string>((resolve, reject) => {
    const tag = `A${Math.random().toString(36).slice(2, 8)}`
    let output = ""
    const onData = (data: Buffer) => {
      output += data.toString("utf8")
      if (output.length > maxBytes) {
        cleanup()
        reject(new Error("IMAP response too large"))
        return
      }
      if (new RegExp(`(^|\\r?\\n)${tag} (OK|NO|BAD)`).test(output)) {
        cleanup()
        if (output.includes(`${tag} OK`)) {
          resolve(output)
          return
        }
        reject(new Error(output.trim().split(/\r?\n/).at(-1) ?? "IMAP command failed"))
      }
    }
    const cleanup = () => {
      conn.off("data", onData)
      clearTimeout(timer)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("IMAP timeout"))
    }, 20000)
    conn.on("data", onData)
    conn.write(`${tag} ${command}\r\n`)
  })
}

function imapQuote(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export function parseMail(raw: string): Omit<Mail, "uid"> {
  const content = extractLiteral(raw)
  const split = content.search(/\r?\n\r?\n/)
  const headerText = split === -1 ? content : content.slice(0, split)
  const bodyText = split === -1 ? "" : content.slice(split).replace(/^\r?\n\r?\n/, "")
  const headers = parseHeaders(headerText)
  const from = headers.get("reply-to") ?? headers.get("from") ?? ""
  return {
    from: extractAddress(from),
    addresses: ["reply-to", "from", "sender", "return-path"].flatMap((key) => extractAddresses(headers.get(key) ?? "")),
    subject: decodeHeader(headers.get("subject") ?? ""),
    messageID: headers.get("message-id"),
    references: headers.get("references"),
    body: cleanMailBody(extractBody(headers, bodyText)).slice(0, 12000),
  }
}

function replyHeaders(input: Pick<Mail, "messageID" | "references">): EmailHeaders | undefined {
  const inReplyTo = normalizeMessageID(input.messageID)
  if (!inReplyTo) return
  const references = [...(input.references?.split(/\s+/).map(normalizeMessageID) ?? []), inReplyTo]
    .filter((item, index, all): item is string => item !== undefined && all.indexOf(item) === index)
    .join(" ")
  return { inReplyTo, references }
}

function normalizeMessageID(value: string | undefined) {
  const id = value?.replace(/[\r\n]+/g, " ").trim()
  if (!id) return
  return id.startsWith("<") && id.endsWith(">") ? id : `<${id.replace(/^<|>$/g, "")}>`
}

function extractLiteral(raw: string): string {
  const match = raw.match(/\{(\d+)\}\r?\n/)
  if (!match || match.index === undefined) return raw
  const size = Number.parseInt(match[1], 10)
  if (!Number.isFinite(size) || size <= 0) return raw
  const start = match.index + match[0].length
  return raw.slice(start, start + size)
}

function parseHeaders(input: string) {
  const headers = new Map<string, string>()
  for (const line of input.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const index = line.indexOf(":")
    if (index === -1) continue
    headers.set(line.slice(0, index).toLowerCase(), line.slice(index + 1).trim())
  }
  return headers
}

function extractBody(headers: Map<string, string>, input: string): string {
  const contentType = parseContentType(headers.get("content-type"))
  if (contentType.mime.startsWith("multipart/")) {
    const boundary = contentType.params.get("boundary")
    if (!boundary) return ""
    return (
      splitMultipart(input, boundary)
        .map(parsePart)
        .filter((part): part is ReturnType<typeof parsePart> & { body: string } => !!part?.body.trim())
        .sort((a, b) => bodyPartScore(b.headers) - bodyPartScore(a.headers))[0]?.body ?? ""
    )
  }
  const decoded = decodeBody(headers, input)
  if (contentType.mime === "text/html") return htmlToText(decoded)
  return decoded
}

function parsePart(input: string): { headers: Map<string, string>; body: string } | undefined {
  const split = input.search(/\r?\n\r?\n/)
  if (split === -1) return
  const headers = parseHeaders(input.slice(0, split))
  return { headers, body: extractBody(headers, input.slice(split).replace(/^\r?\n\r?\n/, "")) }
}

function bodyPartScore(headers: Map<string, string>) {
  const contentType = parseContentType(headers.get("content-type"))
  const disposition = (headers.get("content-disposition") ?? "").toLowerCase()
  if (disposition.includes("attachment")) return 0
  if (contentType.mime === "text/plain") return 3
  if (contentType.mime === "text/html") return 2
  return 1
}

function splitMultipart(input: string, boundary: string) {
  const lines = input.split(/\r?\n/)
  const parts: string[] = []
  let current: string[] | undefined
  for (const line of lines) {
    if (line === `--${boundary}` || line === `--${boundary}--`) {
      if (current?.length) parts.push(current.join("\n"))
      current = line.endsWith("--") ? undefined : []
      continue
    }
    current?.push(line)
  }
  if (current?.length) parts.push(current.join("\n"))
  return parts
}

function parseContentType(input: string | undefined) {
  const [type = "text/plain", ...params] = (input ?? "text/plain").split(";")
  return {
    mime: type.trim().toLowerCase(),
    params: new Map(
      params
        .map((param) => {
          const index = param.indexOf("=")
          if (index === -1) return
          return [
            param.slice(0, index).trim().toLowerCase(),
            param
              .slice(index + 1)
              .trim()
              .replace(/^"|"$/g, ""),
          ] as const
        })
        .filter((item): item is readonly [string, string] => item !== undefined),
    ),
  }
}

function extractAddress(input: string) {
  return extractAddresses(input)[0] ?? input.trim().replace(/^mailto:/i, "")
}

function extractAddresses(input: string) {
  const decoded = decodeHeader(input)
  const bracketed = [...decoded.matchAll(/<([^>]+)>/g)]
    .map((match) => normalizeEmail(match[1]))
    .filter((item): item is string => item !== undefined)
  if (bracketed.length > 0) return bracketed
  return decoded
    .split(/[,\s;]+/)
    .map((item) => normalizeEmail(item))
    .filter((item): item is string => item !== undefined)
}

function normalizeEmail(input: string | undefined) {
  const value = input
    ?.trim()
    .replace(/^mailto:/i, "")
    .replace(/^["']|["']$/g, "")
    .toLowerCase()
  if (!value) return
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(value)) return
  return value
}

function ownerCandidates(cfg: Config.Info) {
  return [cfg.communication?.inbox?.owner, cfg.communication?.finish?.to, OWNER]
    .map(normalizeEmail)
    .filter((item): item is string => item !== undefined)
}

function isOwnerMail(mail: Mail, owners: string[]) {
  const addresses = mail.addresses.length > 0 ? mail.addresses : extractAddresses(mail.from)
  return addresses.some((address) => owners.includes(address))
}

function decodeHeader(input: string) {
  return input.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, charset: string, encoding: string, value: string) => {
    const buffer =
      encoding.toUpperCase() === "B"
        ? Buffer.from(value, "base64")
        : Buffer.from(
            value
              .replace(/_/g, " ")
              .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
            "binary",
          )
    return decodeBuffer(buffer, charset)
  })
}

function decodeBody(headers: Map<string, string>, input: string) {
  const charset = parseContentType(headers.get("content-type")).params.get("charset")
  const encoding = (headers.get("content-transfer-encoding") ?? "").toLowerCase()
  if (encoding.includes("base64")) return decodeBuffer(Buffer.from(input.replace(/\s+/g, ""), "base64"), charset)
  if (encoding.includes("quoted-printable")) {
    return decodeBuffer(
      Buffer.from(
        input
          .replace(/=\r?\n/g, "")
          .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))),
        "binary",
      ),
      charset,
    )
  }
  return input
}

function decodeBuffer(buffer: Buffer, charset: string | undefined) {
  const label = charset?.trim().toLowerCase()
  try {
    return new TextDecoder(label === "gb2312" || label === "gbk" ? "gb18030" : label || "utf-8").decode(buffer)
  } catch {
    return new TextDecoder().decode(buffer)
  }
}

function cleanMailBody(input: string) {
  return input
    .replace(/\r\n/g, "\n")
    .split(/\n_{5,}\n/)[0]
    .replace(/^Get Outlook for .+$/gim, "")
    .replace(/^Sent from my .+$/gim, "")
    .replace(/^\s+|\s+$/g, "")
}

function htmlToText(input: string) {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
}

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
)

export * as MailMonitor from "./mail-monitor"
