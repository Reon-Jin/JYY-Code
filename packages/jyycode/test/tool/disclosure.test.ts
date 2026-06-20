import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ToolDisclosure } from "@/tool/disclosure"
import { Tool } from "@/tool/tool"

const Params = Schema.Struct({})

function def(id: string, catalog: Tool.CatalogMetadata = {}): Tool.Def<typeof Params> {
  return {
    id,
    description: `${id} tool`,
    parameters: Params,
    catalog,
    execute: () => {
      throw new Error("not used")
    },
  }
}

describe("ToolDisclosure.partition", () => {
  test("keeps every tool direct when disabled", () => {
    const tools = [def("read"), def("send_message", { category: "communication" })]

    const result = ToolDisclosure.partition({
      tools,
      enabled: false,
      threshold: 1,
    })

    expect(result.direct.map((tool) => tool.id)).toEqual(["read", "send_message"])
    expect(result.hidden).toEqual([])
  })

  test("keeps core tools direct and hides communication tools when enabled over threshold", () => {
    const tools = [
      def("tool_search"),
      def("read", { category: "filesystem", detail: "core" }),
      def("grep", { category: "code-search", detail: "core" }),
      def("send_message", { category: "communication", detail: "advanced" }),
    ]

    const result = ToolDisclosure.partition({
      tools,
      enabled: true,
      threshold: 2,
    })

    expect(result.direct.map((tool) => tool.id)).toEqual(["tool_search", "read", "grep"])
    expect(result.hidden.map((tool) => tool.id)).toEqual(["send_message"])
  })

  test("does not defer below threshold", () => {
    const tools = [def("read"), def("send_message", { category: "communication" })]

    const result = ToolDisclosure.partition({
      tools,
      enabled: true,
      threshold: 10,
    })

    expect(result.direct.map((tool) => tool.id)).toEqual(["read", "send_message"])
    expect(result.hidden).toEqual([])
  })
})
