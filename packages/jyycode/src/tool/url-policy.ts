import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { Effect, Schema } from "effect"

export type ResolveAll = (hostname: string) => Promise<string[]>

export class UrlPolicyError extends Schema.TaggedErrorClass<UrlPolicyError>()("UrlPolicyError", {
  url: Schema.String,
  reason: Schema.String,
  address: Schema.optional(Schema.String),
}) {
  override get message() {
    return this.address
      ? `URL blocked by network policy: ${this.url} resolves to ${this.address} (${this.reason})`
      : `URL blocked by network policy: ${this.url} (${this.reason})`
  }
}

const resolveAll: ResolveAll = async (hostname) => {
  const entries = await lookup(hostname, { all: true, verbatim: true })
  return entries.map((entry) => entry.address)
}

function ipv4Value(address: string): number | undefined {
  if (isIP(address) !== 4) return undefined
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

function ipv6Value(address: string): bigint | undefined {
  const normalizedAddress = address.replace(/^\[|\]$/g, "")
  if (isIP(normalizedAddress) !== 6) return undefined
  let normalized = normalizedAddress.toLowerCase().split("%", 1)[0]!
  const embeddedIpv4 = normalized.match(/(^|:)(\d+\.\d+\.\d+\.\d+)$/)
  if (embeddedIpv4) {
    const value = ipv4Value(embeddedIpv4[2]!)
    if (value === undefined) return undefined
    const high = ((value >>> 16) & 0xffff).toString(16)
    const low = (value & 0xffff).toString(16)
    normalized = `${normalized.slice(0, embeddedIpv4.index! + embeddedIpv4[1]!.length)}${high}:${low}`
  }
  const halves = normalized.split("::")
  if (halves.length > 2) return undefined

  const parseGroup = (group: string): number[] | undefined => {
    if (!group) return []
    const groups = group.split(":")
    if (groups.some((item) => !/^[0-9a-f]{1,4}$/i.test(item))) return undefined
    return groups.map((item) => Number.parseInt(item, 16))
  }

  let groups: number[]
  if (halves.length === 2) {
    const left = parseGroup(halves[0]!)
    const right = parseGroup(halves[1]!)
    if (!left || !right || left.length + right.length >= 8) return undefined
    groups = [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
  } else {
    const parsed = parseGroup(normalized)
    if (!parsed || parsed.length !== 8) return undefined
    groups = parsed
  }

  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n)
}

function ipv6InRange(value: bigint, network: bigint, prefix: number): boolean {
  const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n)
  return (value & mask) === (network & mask)
}

function isBlockedIpv4(value: number): boolean {
  const ranges: Array<[number, number]> = [
    [0x00000000, 8], // unspecified/current network
    [0x0a000000, 8], // RFC 1918
    [0x64400000, 10], // carrier-grade NAT
    [0x7f000000, 8], // loopback
    [0xa9fe0000, 16], // link-local / metadata
    [0xac100000, 12], // RFC 1918
    [0xc0000000, 24], // IETF protocol assignments
    [0xc0120000, 15], // benchmarking
    [0xc0a80000, 16], // RFC 1918
    [0xe0000000, 4], // multicast
    [0xf0000000, 4], // reserved
  ]

  return ranges.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return (value & mask) === (network & mask)
  })
}

export function isPrivateNetworkAddress(address: string): boolean {
  const v4 = ipv4Value(address)
  if (v4 !== undefined) return isBlockedIpv4(v4)

  const v6 = ipv6Value(address)
  if (v6 === undefined) return false

  // IPv4-mapped IPv6 addresses must use the IPv4 policy too.
  if ((v6 >> 32n) === 0xffffn) return isBlockedIpv4(Number(v6 & 0xffffffffn))

  return (
    ipv6InRange(v6, 0n, 128) || // unspecified ::
    ipv6InRange(v6, 1n, 128) || // loopback ::1
    ipv6InRange(v6, 0xfc000000000000000000000000000000n, 7) || // unique local
    ipv6InRange(v6, 0xfe800000000000000000000000000000n, 10) || // link-local
    ipv6InRange(v6, 0xff000000000000000000000000000000n, 8) // multicast
  )
}

export async function assertUrlAllowed(
  input: string,
  options: { allowPrivate?: boolean; resolve?: ResolveAll } = {},
): Promise<URL> {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new UrlPolicyError({ url: input, reason: "invalid URL" })
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlPolicyError({ url: url.toString(), reason: "only http and https are allowed" })
  }

  if (options.allowPrivate) return url

  let addresses: string[]
  try {
    addresses = await (options.resolve ?? resolveAll)(url.hostname)
  } catch (cause) {
    throw new UrlPolicyError({ url: url.toString(), reason: `DNS resolution failed: ${String(cause)}` })
  }

  if (addresses.length === 0) {
    throw new UrlPolicyError({ url: url.toString(), reason: "hostname has no resolved addresses" })
  }

  const blocked = addresses.find(isPrivateNetworkAddress)
  if (blocked) {
    throw new UrlPolicyError({ url: url.toString(), reason: "private or special-use network", address: blocked })
  }

  return url
}

export const assertUrlAllowedEffect = (
  input: string,
  options?: { allowPrivate?: boolean; resolve?: ResolveAll },
) =>
  Effect.tryPromise({
    try: () => assertUrlAllowed(input, options),
    catch: (error) => (error instanceof UrlPolicyError ? error : new UrlPolicyError({ url: input, reason: String(error) })),
  })
