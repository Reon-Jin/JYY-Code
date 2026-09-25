import { Auth } from "@/auth"
import { ProviderID } from "@/provider/schema"
import { JEV_CREDENTIAL_ID, jevApiKey } from "@/tool/computer/mode"
import { prewarmComputerVision } from "@/tool/computer/choose"
import * as Log from "@jyycode-ai/core/util/log"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const authStatus = Effect.fn("ControlHttpApi.authStatus")(function* (ctx: { params: { providerID: ProviderID } }) {
      if (ctx.params.providerID === JEV_CREDENTIAL_ID) {
        return { active: !!jevApiKey(yield* auth.get(ctx.params.providerID).pipe(Effect.orDie)) }
      }
      return { active: !!(yield* auth.getPublic(ctx.params.providerID).pipe(Effect.orDie)) }
    })

    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (ctx: {
      params: { providerID: ProviderID }
      payload: Auth.Info
    }) {
      yield* auth.set(ctx.params.providerID, ctx.payload).pipe(Effect.orDie)
      if (ctx.params.providerID === JEV_CREDENTIAL_ID && jevApiKey(ctx.payload)) prewarmComputerVision()
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (ctx: { params: { providerID: ProviderID } }) {
      yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)
      return true
    })

    const log = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) {
      const logger = Log.create({ service: ctx.payload.service })
      logger[ctx.payload.level](ctx.payload.message, ctx.payload.extra)
      return true
    })

    return handlers.handle("authStatus", authStatus).handle("authSet", authSet).handle("authRemove", authRemove).handle("log", log)
  }),
)
