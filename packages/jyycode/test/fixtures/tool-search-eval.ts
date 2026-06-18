export const toolSearchEvalFixtures = [
  {
    query: "change one file",
    expectedTopK: ["apply_patch", "edit", "write"],
  },
  {
    query: "find symbol definition",
    expectedTopK: ["lsp", "grep"],
  },
  {
    query: "send file to user",
    expectedTopK: ["send_file"],
  },
  {
    query: "query jira mcp",
    expectedTopK: ["mcp_call", "tool_exec"],
  },
  {
    query: "search docs",
    expectedTopK: ["search", "fetch"],
  },
] as const
