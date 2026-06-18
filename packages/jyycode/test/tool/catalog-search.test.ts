import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { CatalogSearch } from "@/tool/catalog-search"
import type { Tool } from "@/tool/tool"

const Empty = Schema.Struct({})

function tool(input: {
  id: string
  description: string
  catalog?: Tool.CatalogMetadata
  parameters?: Tool.Def["parameters"]
  jsonSchema?: Tool.Def["jsonSchema"]
}): Tool.Def {
  return {
    id: input.id,
    description: input.description,
    catalog: input.catalog,
    parameters: input.parameters ?? Empty,
    jsonSchema: input.jsonSchema,
    execute: () => {
      throw new Error("not implemented")
    },
  }
}

describe("CatalogSearch", () => {
  it("ranks exact ID matches above description-only matches", () => {
    const results = CatalogSearch.search({
      query: "read",
      tools: [
        tool({ id: "webfetch", description: "Read a remote URL" }),
        tool({ id: "read", description: "Open a local file" }),
      ],
    })

    expect(results.map((item) => item.tool.id)).toEqual(["read", "webfetch"])
  })

  it("uses category and tags to improve score", () => {
    const results = CatalogSearch.search({
      query: "filesystem inspect",
      tools: [
        tool({ id: "search", description: "Search web docs" }),
        tool({
          id: "glob",
          description: "Find files by pattern",
          catalog: { category: "filesystem", tags: ["inspect"] },
        }),
      ],
    })

    expect(results[0]?.tool.id).toBe("glob")
  })

  it("ranks file edit tools above web tools for edit file", () => {
    const results = CatalogSearch.search({
      query: "edit file",
      tools: [
        tool({
          id: "webfetch",
          description: "Fetch and read content from a URL",
          catalog: { category: "web", mutability: "external" },
        }),
        tool({
          id: "apply_patch",
          description: "Apply changes to files",
          catalog: { category: "filesystem", mutability: "write", tags: ["edit", "file"] },
        }),
        tool({
          id: "edit",
          description: "Edit a file",
          catalog: { category: "filesystem", mutability: "write" },
        }),
      ],
    })

    expect(results.slice(0, 2).map((item) => item.tool.id)).toEqual(["edit", "apply_patch"])
  })

  it("clamps limits to the supported range", () => {
    const tools = Array.from({ length: 25 }, (_, index) =>
      tool({ id: `tool_${index.toString().padStart(2, "0")}`, description: "common match" }),
    )

    expect(CatalogSearch.search({ query: "common", tools, limit: 0 })).toHaveLength(1)
    expect(CatalogSearch.search({ query: "common", tools, limit: 50 })).toHaveLength(20)
  })

  it("formats detail levels with progressively larger output", () => {
    const result = CatalogSearch.search({
      query: "edit",
      tools: [
        tool({
          id: "edit",
          description: "Edit a file",
          catalog: { category: "filesystem", mutability: "write", risk: "high", tags: ["patch"] },
          jsonSchema: {
            type: "object",
            properties: {
              filePath: { type: "string" },
              oldString: { type: "string" },
            },
            required: ["filePath", "oldString"],
          },
        }),
      ],
    })[0]

    const summary = CatalogSearch.formatResults([result], { detail: "summary" })
    const schema = CatalogSearch.formatResults([result], { detail: "schema" })
    const full = CatalogSearch.formatResults([result], { detail: "full" })

    expect(summary).toContain("- edit")
    expect(summary).not.toContain("oldString")
    expect(schema).toContain("oldString")
    expect(full).toContain("score:")
    expect(summary.length).toBeLessThan(schema.length)
    expect(schema.length).toBeLessThan(full.length)
  })
})
