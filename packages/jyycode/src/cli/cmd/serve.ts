import { Effect } from "effect"
import { Server } from "../../server/server"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@jyycode-ai/core/flag/flag"

const readyOptions = {
  json: {
    type: "boolean" as const,
    default: false,
    describe: "print a machine-readable server.ready event",
  },
}

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs).options(readyOptions),
  describe: "starts a headless jyycode server",
  // Server loads instances per-request via x-jyycode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (!Flag.JYYCODE_SERVER_PASSWORD) {
      console.log("Warning: JYYCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    const ready = {
      type: "server.ready" as const,
      hostname: server.hostname,
      port: server.port,
    }
    console.log(
      args.json ? JSON.stringify(ready) : `jyycode server listening on http://${server.hostname}:${server.port}`,
    )

    yield* Effect.never
  }),
})
