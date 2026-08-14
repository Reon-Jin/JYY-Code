import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@jyycode/ExperimentalHttpApiInstanceContext") {}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

/**
 * These read-only surfaces only need a project context. They must not wait on
 * plugin, LSP, file-index, or other optional instance bootstrap work.
 */
export function shouldUseFastInstanceLoad(request: HttpServerRequest.HttpServerRequest) {
  if (request.method !== "GET") return false

  const pathname = new URL(request.url, "http://localhost").pathname.replace(/\/+$/, "") || "/"
  const path = pathname.startsWith("/api/") ? pathname.slice("/api".length) : pathname
  return (
    path === "/agent" ||
    path === "/subagents" ||
    path === "/project/current" ||
    path === "/file" ||
    path.startsWith("/file/") ||
    path === "/find" ||
    path.startsWith("/find/")
  )
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
) {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const request = yield* HttpServerRequest.HttpServerRequest
    const load = shouldUseFastInstanceLoad(request) ? store.loadFast : store.load
    const ctx = yield* load({ directory: decode(route.directory) })
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)

export const instanceRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return (effect) => provideInstanceContext(effect, store)
  }),
)
