import { createRelay } from "./relay"

const relay = createRelay({
  hostname: Bun.env.HOSTNAME ?? "0.0.0.0",
  port: Bun.env.PORT ? Number(Bun.env.PORT) : 8787,
})

console.log(`JYYCode relay listening on ws://${relay.hostname}:${relay.port}/connect`)
