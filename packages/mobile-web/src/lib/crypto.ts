import { chacha20poly1305 } from "@noble/ciphers/chacha"

export type PairingInvitation = {
  routeId: string
  relayUrl: string
  pairingSecret: string
  temporaryPublicKey: string
  expiresAt: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const HKDF_INFO = encoder.encode("JYYCodeMobilePairing-v1")

export function parsePairingInvitation(value: string | unknown): PairingInvitation {
  const candidate = typeof value === "string" ? JSON.parse(value) : value
  if (!candidate || typeof candidate !== "object") throw new Error("二维码内容无效")
  const data = candidate as Record<string, unknown>
  if (
    !isIdentifier(data.routeId) ||
    !isSecureRelayUrl(data.relayUrl) ||
    !isHex(data.pairingSecret, 64) ||
    !isHex(data.temporaryPublicKey, 64) ||
    typeof data.expiresAt !== "number" ||
    !Number.isSafeInteger(data.expiresAt)
  ) {
    throw new Error("二维码内容无效")
  }
  if (data.expiresAt * 1000 <= Date.now()) throw new Error("二维码已失效，请在电脑上重新生成")
  return {
    routeId: data.routeId,
    relayUrl: data.relayUrl,
    pairingSecret: data.pairingSecret,
    temporaryPublicKey: data.temporaryPublicKey,
    expiresAt: data.expiresAt,
  }
}

export async function createPairingKeyPair() {
  ensureX25519()
  const keyPair = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
  return { privateKey: keyPair.privateKey, publicKey: bytesToHex(publicKey) }
}

export async function deriveSessionKey(privateKey: CryptoKey, desktopPublicKey: string, pairingSecret: string) {
  ensureX25519()
  const peer = await crypto.subtle.importKey("raw", hexToBytes(desktopPublicKey), { name: "X25519" }, false, [])
  const sharedSecret = await crypto.subtle.deriveBits({ name: "X25519", public: peer }, privateKey, 256)
  const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"])
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: encoder.encode(pairingSecret), info: HKDF_INFO },
      hkdfKey,
      256,
    ),
  )
}

export async function sealSessionKey(sessionKey: Uint8Array) {
  const vaultKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, vaultKey, sessionKey)
  return { vaultKey, sealedSessionKey: toBase64(joinBytes(nonce, new Uint8Array(ciphertext))) }
}

export async function openSessionKey(vaultKey: CryptoKey, sealedSessionKey: string) {
  const value = fromBase64(sealedSessionKey)
  if (value.length <= 12) throw new Error("本地安全存储无效")
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: value.slice(0, 12) }, vaultKey, value.slice(12)),
  )
}

export function encryptPayload(key: Uint8Array, value: unknown) {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = chacha20poly1305(key, nonce).encrypt(encoder.encode(JSON.stringify(value)))
  return toBase64(joinBytes(nonce, ciphertext))
}

export function decryptPayload<T>(key: Uint8Array, ciphertext: string): T {
  const value = fromBase64(ciphertext)
  if (value.length <= 12) throw new Error("加密响应无效")
  const plaintext = chacha20poly1305(key, value.slice(0, 12)).decrypt(value.slice(12))
  return JSON.parse(decoder.decode(plaintext)) as T
}

export function bytesToHex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function hexToBytes(value: string) {
  if (!isHex(value)) throw new Error("密钥格式无效")
  return Uint8Array.from(value.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)))
}

function ensureX25519() {
  if (!crypto?.subtle) throw new Error("当前 Safari 不支持安全配对")
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
}

function isHex(value: unknown, length?: number): value is string {
  return typeof value === "string" && (!length || value.length === length) && /^[0-9a-f]+$/i.test(value)
}

function isSecureRelayUrl(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return url.protocol === "wss:" || (url.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  } catch {
    return false
  }
}

function joinBytes(...values: Uint8Array[]) {
  const output = new Uint8Array(values.reduce((total, value) => total + value.length, 0))
  let offset = 0
  for (const value of values) {
    output.set(value, offset)
    offset += value.length
  }
  return output
}

function toBase64(value: Uint8Array) {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
