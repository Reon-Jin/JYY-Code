import { Schema } from "effect"

export const Channel = Schema.Literals(["email", "wechat", "qq"])
export type Channel = Schema.Schema.Type<typeof Channel>

export const SendMessageInput = Schema.Struct({
  channel: Schema.optional(Channel),
  to: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.String),
  body: Schema.String,
  cc: Schema.optional(Schema.String),
})
export type SendMessageInput = Schema.Schema.Type<typeof SendMessageInput>

export const SendFileInput = Schema.Struct({
  channel: Schema.optional(Channel),
  to: Schema.optional(Schema.String),
  filePath: Schema.String,
  subject: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
})
export type SendFileInput = Schema.Schema.Type<typeof SendFileInput>

export const SendResult = Schema.Struct({
  success: Schema.Boolean,
  channel: Channel,
  message: Schema.String,
})
export type SendResult = Schema.Schema.Type<typeof SendResult>

export type EmailHeaders = {
  inReplyTo?: string
  references?: string
}

export interface Adapter {
  readonly channel: Channel
  send(
    config: AdapterConfig,
    input: { to: string; body: string; subject?: string; cc?: string; headers?: EmailHeaders },
  ): Promise<SendResult>
  sendFile(
    config: AdapterConfig,
    input: { to: string; filePath: string; body?: string; subject?: string },
  ): Promise<SendResult>
}

export const EmailConfig = Schema.Struct({
  smtpHost: Schema.String,
  smtpPort: Schema.optional(Schema.Number),
  imapHost: Schema.optional(Schema.String),
  imapPort: Schema.optional(Schema.Number),
  mailbox: Schema.optional(Schema.String),
  username: Schema.String,
  password: Schema.String,
  from: Schema.String,
  authMethod: Schema.optional(Schema.Literals(["password", "oauth2"])),
  clientId: Schema.optional(Schema.String),
  tenant: Schema.optional(Schema.String),
  refreshToken: Schema.optional(Schema.String),
})

export const AdapterConfig = Schema.Struct({
  email: Schema.optional(EmailConfig),
})
export type AdapterConfig = Schema.Schema.Type<typeof AdapterConfig>
export type EmailConfigType = Schema.Schema.Type<typeof EmailConfig>
