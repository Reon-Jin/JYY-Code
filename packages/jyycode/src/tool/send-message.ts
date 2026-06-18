import { Effect } from "effect"
import * as Tool from "./tool"
import { sendMessage } from "../communication"
import type { AdapterConfig } from "../communication/schema"
import { SendMessageInput } from "../communication/schema"
import DESCRIPTION from "./send-message.txt"
import { Config } from "@/config/config"
import * as Log from "@jyycode-ai/core/util/log"
import { defaultEmailRecipient } from "@/communication/defaults"

const log = Log.create({ service: "tool.send-message" })

export const Parameters = SendMessageInput

export const SendMessageTool = Tool.define(
  "send_message",
  Effect.gen(function* () {
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      catalog: {
        category: "communication",
        mutability: "external",
        risk: "high",
        detail: "advanced",
      },
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const channel = params.channel ?? "email"
          const to = params.to ?? defaultEmailRecipient(cfg)
          yield* ctx.ask({
            permission: "send_message",
            patterns: [channel, to],
            always: [],
            metadata: {},
          })

          const commConfig: AdapterConfig = {
            email: cfg.communication?.email
              ? {
                  smtpHost: cfg.communication.email.smtpHost,
                  smtpPort: cfg.communication.email.smtpPort ?? 465,
                  username: cfg.communication.email.username,
                  password: cfg.communication.email.password,
                  from: cfg.communication.email.from,
                  authMethod: cfg.communication.email.authMethod,
                  clientId: cfg.communication.email.clientId,
                  tenant: cfg.communication.email.tenant,
                  refreshToken: cfg.communication.email.refreshToken,
                }
              : undefined,
          }

          log.info("sending message", { channel, to })
          const result = yield* Effect.promise(() =>
            sendMessage(commConfig, {
              channel,
              to,
              body: params.body,
              subject: params.subject,
              cc: params.cc,
            }),
          )

          return {
            title: result.success ? `Message sent via ${channel}` : `FAILED: ${channel}`,
            output: result.success
              ? `Message sent successfully to ${to} via ${channel}.`
              : `FAILED to send message: ${result.message}`,
            metadata: result as Record<string, unknown>,
          }
        }),
    }
  }),
)
