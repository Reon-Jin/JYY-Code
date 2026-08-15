import { describe, expect, test } from "bun:test"
import { StorageCommand } from "@/cli/cmd/storage"

describe("storage CLI", () => {
  test("registers storage maintenance subcommands", () => {
    const builder = StorageCommand.builder as unknown as (arg: unknown) => unknown
    if (!builder) throw new Error("storage command has no builder")
    const commands: string[] = []
    const fake = {
      command(command: { command: string }) {
        commands.push(command.command)
        return fake
      },
      demandCommand() {
        return fake
      },
    }
    builder(fake)
    expect(StorageCommand.command).toBe("storage")
    expect(commands).toEqual(["inspect", "cleanup", "gc", "maintain", "backfill"])
  })
})
