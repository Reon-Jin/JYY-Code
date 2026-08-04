import { PROTOCOL_VERSION, parseRelayMessage, type RelayEnvelope } from "@jyycode-ai/mobile-protocol"
import {
  createPairingKeyPair,
  decryptPayload,
  deriveSessionKey,
  encryptPayload,
  openSessionKey,
  parsePairingInvitation,
  sealSessionKey,
  type PairingInvitation,
} from "./crypto"
import { DeviceStore, type StoredDevice } from "./device-store"
import type { RemoteAction, RemoteDetail, RemoteTask } from "./models"

type RelayResponse =
  | { type: "pairResult"; ok: boolean }
  | { type: "summaryResult"; tasks: RemoteTask[] }
  | { type: "summaryUpdate"; tasks: RemoteTask[] }
  | { type: "commandResult"; ok: boolean; error?: string; data?: RemoteDetail }

type Pending = { resolve: (value: RelayResponse) => void; reject: (reason: Error) => void; timeout: number }

export type RelayState = "offline" | "connecting" | "online"
export type RelayClientOptions = {
  store?: DeviceStore
  onTasks?: (tasks: RemoteTask[]) => void
  onState?: (state: RelayState) => void
}

export class RelayClient {
  readonly store: DeviceStore
  private socket?: WebSocket
  private device?: StoredDevice
  private sessionKey?: Uint8Array
  private sequence = 0
  private incomingSequence = 0
  private reconnectTimer?: number
  private reconnectDelay = 1_000
  private stopped = false
  private pending = new Map<string, Pending>()
  private readonly onTasks?: (tasks: RemoteTask[]) => void
  private readonly onState?: (state: RelayState) => void

  constructor(options: RelayClientOptions = {}) {
    this.store = options.store ?? new DeviceStore()
    this.onTasks = options.onTasks
    this.onState = options.onState
  }

  async pair(qrPayload: string, deviceName = "Safari 浏览器") {
    const invitation = parsePairingInvitation(qrPayload)
    const keyPair = await createPairingKeyPair()
    const id = `web_${crypto.randomUUID()}`
    const sessionKey = await deriveSessionKey(
      keyPair.privateKey,
      invitation.temporaryPublicKey,
      invitation.pairingSecret,
    )
    const sealed = await sealSessionKey(sessionKey)
    const device: StoredDevice = {
      id,
      name: deviceName.slice(0, 128) || "Safari 浏览器",
      routeId: invitation.routeId,
      relayUrl: invitation.relayUrl,
      ...sealed,
      pairedAt: Date.now(),
    }
    await this.useDevice(device, sessionKey)
    await this.connect()
    const result = await this.request(
      {
        type: "pair",
        deviceId: id,
        deviceName: device.name,
        publicKey: keyPair.publicKey,
        pairingSecret: invitation.pairingSecret,
      },
      keyPair.publicKey,
    )
    if (result.type !== "pairResult" || !result.ok) throw new Error("电脑拒绝了配对请求")
    await this.store.put(device)
    return device
  }

  async selectDevice(deviceID: string) {
    const device = await this.store.get(deviceID)
    if (!device) throw new Error("已配对的浏览器设备不存在")
    await this.useDevice(device, await openSessionKey(device.vaultKey, device.sealedSessionKey))
    await this.connect()
    return this.refresh()
  }

  async restore(device: StoredDevice, sessionKey: Uint8Array) {
    await this.useDevice(device, sessionKey)
    await this.connect()
    return this.refresh()
  }

  async refresh() {
    const result = await this.request({ type: "summary" })
    if (result.type !== "summaryResult") throw new Error("电脑返回了无效的任务摘要")
    this.onTasks?.(result.tasks)
    return result.tasks
  }

  async command(taskID: string, action: RemoteAction) {
    const result = await this.request({ type: "command", id: `command_${crypto.randomUUID()}`, taskId: taskID, action })
    if (result.type !== "commandResult") throw new Error("电脑返回了无效的操作结果")
    if (!result.ok) throw new Error(result.error || "操作未完成")
    return result.data
  }

  async revokeCurrentDevice() {
    await this.command("", { type: "revokeDevice" })
    if (this.device) await this.store.remove(this.device.id)
    this.disconnect()
  }

  disconnect() {
    this.stopped = true
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.socket?.close()
    this.socket = undefined
    this.failPending(new Error("已断开连接"))
    this.onState?.("offline")
  }

  private async useDevice(device: StoredDevice, sessionKey: Uint8Array) {
    this.device = device
    this.sessionKey = sessionKey
    this.stopped = false
    this.sequence = 0
    this.incomingSequence = 0
  }

  private connect() {
    if (!this.device) throw new Error("请先扫描电脑二维码")
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    this.onState?.("connecting")
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.device!.relayUrl)
      this.socket = socket
      const timeout = window.setTimeout(() => reject(new Error("连接中继服务超时")), 10_000)
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: "relay.hello",
            protocolVersion: PROTOCOL_VERSION,
            routeID: this.device!.routeId,
            clientID: this.device!.id,
            role: "web",
          }),
        )
      }
      socket.onmessage = (event) => {
        try {
          const raw = JSON.parse(String(event.data)) as Record<string, unknown>
          if (raw.type === "relay.ready") {
            window.clearTimeout(timeout)
            this.reconnectDelay = 1_000
            this.onState?.("online")
            resolve()
            return
          }
          this.handleEnvelope(raw)
        } catch (error) {
          this.failPending(error instanceof Error ? error : new Error("收到无效的中继消息"))
        }
      }
      socket.onerror = () => {
        window.clearTimeout(timeout)
        reject(new Error("无法连接中继服务"))
      }
      socket.onclose = () => {
        window.clearTimeout(timeout)
        if (this.socket === socket) this.socket = undefined
        this.onState?.("offline")
        if (!this.stopped) this.scheduleReconnect()
      }
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.device) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect()
        .then(() => this.refresh())
        .catch(() => undefined)
    }, delay)
  }

  private request(payload: Record<string, unknown>, pairingPublicKey?: string) {
    if (!this.device || !this.sessionKey || this.socket?.readyState !== WebSocket.OPEN) throw new Error("电脑当前离线")
    const correlationID = `request_${crypto.randomUUID()}`
    const envelope = {
      type: "relay.envelope",
      protocolVersion: PROTOCOL_VERSION,
      routeID: this.device.routeId,
      senderID: this.device.id,
      recipientID: this.device.routeId,
      messageID: `message_${crypto.randomUUID()}`,
      correlationID,
      ...(pairingPublicKey ? { pairingPublicKey } : {}),
      sequence: ++this.sequence,
      ciphertext: encryptPayload(this.sessionKey, payload),
    }
    return new Promise<RelayResponse>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(correlationID)
        reject(new Error("电脑响应超时，请检查桌面端是否在线"))
      }, 20_000)
      this.pending.set(correlationID, { resolve, reject, timeout })
      this.socket!.send(JSON.stringify(envelope))
    })
  }

  private handleEnvelope(raw: Record<string, unknown>) {
    const envelope = parseRelayMessage(raw)
    if (envelope.type !== "relay.envelope" || !this.device || !this.sessionKey) return
    if (
      envelope.routeID !== this.device.routeId ||
      envelope.recipientID !== this.device.id ||
      envelope.sequence <= this.incomingSequence
    )
      return
    this.incomingSequence = envelope.sequence
    const payload = decryptPayload<RelayResponse>(this.sessionKey, envelope.ciphertext)
    void this.store.put({ ...this.device, lastSeen: Date.now() })
    if (payload.type === "summaryUpdate") {
      this.onTasks?.(payload.tasks)
      return
    }
    const correlationID = envelope.correlationID
    if (!correlationID) return
    const pending = this.pending.get(correlationID)
    if (!pending) return
    window.clearTimeout(pending.timeout)
    this.pending.delete(correlationID)
    pending.resolve(payload)
  }

  private failPending(error: Error) {
    for (const [id, pending] of this.pending) {
      window.clearTimeout(pending.timeout)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

export function invitationFromPayload(payload: string): PairingInvitation {
  return parsePairingInvitation(payload)
}

export function isRelayEnvelope(value: unknown): value is RelayEnvelope {
  return parseRelayMessage(value).type === "relay.envelope"
}
