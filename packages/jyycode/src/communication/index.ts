import { EmailAdapter } from "./email"
import { WeChatAdapter } from "./wechat"
import { QQAdapter } from "./qq"
import type { Adapter, AdapterConfig, Channel, EmailHeaders, SendResult } from "./schema"

const adapters: Record<Channel, Adapter> = {
  email: EmailAdapter,
  wechat: WeChatAdapter,
  qq: QQAdapter,
}

export async function sendMessage(
  config: AdapterConfig,
  input: { channel: Channel; to: string; body: string; subject?: string; cc?: string; headers?: EmailHeaders },
): Promise<SendResult> {
  const adapter = adapters[input.channel]
  return adapter.send(config, input)
}

export async function sendFile(
  config: AdapterConfig,
  input: { channel: Channel; to: string; filePath: string; body?: string; subject?: string },
): Promise<SendResult> {
  const adapter = adapters[input.channel]
  return adapter.sendFile(config, input)
}

export type { Adapter, AdapterConfig, Channel, SendResult }
