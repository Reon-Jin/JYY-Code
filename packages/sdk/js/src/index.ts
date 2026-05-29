export * from "./client.js"
export * from "./server.js"

import { createJyycodeClient } from "./client.js"
import { createJyycodeServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createJyycode(options?: ServerOptions) {
  const server = await createJyycodeServer({
    ...options,
  })

  const client = createJyycodeClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
