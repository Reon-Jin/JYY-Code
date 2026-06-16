import { describe, expect, test } from "bun:test"
import { generatorsAll } from "../../src/util/sequential"

async function* values(items: number[]) {
  for (const item of items) yield item
}

describe("generatorsAll", () => {
  test("yields values from multiple generators", async () => {
    const out: number[] = []
    for await (const item of generatorsAll([values([1, 2]), values([3])], 2)) out.push(item)
    expect(out.sort()).toEqual([1, 2, 3])
  })

  test("respects concurrency cap of one", async () => {
    const out: number[] = []
    for await (const item of generatorsAll([values([1]), values([2])], 1)) out.push(item)
    expect(out).toEqual([1, 2])
  })
})
