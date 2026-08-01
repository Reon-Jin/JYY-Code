export const toolSearchEvalFixtures = [
  {
    query: "change one file",
    expectedTopK: ["edit", "write"],
  },
  {
    query: "find symbol definition",
    expectedTopK: ["grep"],
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
