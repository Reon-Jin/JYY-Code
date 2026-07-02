export * as Sqlite from "./sqlite"

import { Context } from "effect"
import type { Database } from "bun:sqlite"
import type { drizzle } from "drizzle-orm/bun-sqlite"

export type NativeClient = Database
export type DrizzleClient = ReturnType<typeof drizzle>

export class Native extends Context.Service<Native, NativeClient>()("@jyycode-ai/core/database/SqliteNative") {}
export class Drizzle extends Context.Service<Drizzle, DrizzleClient>()("@jyycode-ai/core/database/SqliteDrizzle") {}
