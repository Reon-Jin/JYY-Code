import { createRelay } from "./relay"

const relay = createRelay({
  hostname: Bun.env.HOSTNAME ?? "0.0.0.0",
  port: Bun.env.PORT ? Number(Bun.env.PORT) : 8787,
  staticRoot: Bun.env.JYYCODE_MOBILE_WEB_ROOT,
})

console.log(`JYYCode relay listening on ws://${relay.hostname}:${relay.port}/connect`)
if (Bun.env.JYYCODE_MOBILE_WEB_ROOT) console.log(`JYYCode Safari web app served on http://${relay.hostname}:${relay.port}/`)
