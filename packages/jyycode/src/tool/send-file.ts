import { Effect } from "effect"
import * as Tool from "./tool"
import { sendFile } from "../communication"
import type { AdapterConfig } from "../communication/schema"
import { SendFileInput } from "../communication/schema"
import DESCRIPTION from "./send-file.txt"
import { Config } from "@/config/config"
import * as Log from "@jyycode-ai/core/util/log"
import { existsSync } from "node:fs"
import { defaultEmailRecipient } from "@/communication/defaults"

const log = Log.create({ service: "tool.send-file" })

export const Parameters = SendFileInput

export const SendFileTool = Tool.define(
  "send_file",
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
            permission: "send_file",
            patterns: [channel, to, params.filePath],
            always: [],
            metadata: {},
          })

          if (!existsSync(params.filePath)) {
            return {
              title: "File not found",
              output: `File not found at path: ${params.filePath}. Please verify the path is correct.`,
              metadata: { success: false, reason: "file_not_found" },
            }
          }

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

          log.info("sending file", {
            channel,
            to,
            filePath: params.filePath,
          })

          const result = yield* Effect.promise(() =>
            sendFile(commConfig, {
              channel,
              to,
              filePath: params.filePath,
              body: params.body,
              subject: params.subject,
            }),
          )

          return {
            title: result.success ? `File sent via ${channel}` : `FAILED: ${channel}`,
            output: result.success
              ? `File ${params.filePath.split(/[/\\]/).pop()} sent successfully to ${to} via ${channel}.`
              : `FAILED to send file: ${result.message}`,
            metadata: result as Record<string, unknown>,
          }
        }),
    }
  }),
)
