import type { PermissionRequest, QuestionRequest } from "@jyycode-ai/sdk/v2/client"
import { describe, expect, it, vi } from "vitest"
import { loadPermissionRequests, loadQuestionRequests, selectActiveRequest } from "./request-query"

const directory = "C:\\work\\demo"
const permission: PermissionRequest = {
  id: "per_1",
  sessionID: "ses_1",
  permission: "bash",
  patterns: ["git status"],
  metadata: {},
  always: ["git *"],
}
const question: QuestionRequest = {
  id: "que_1",
  sessionID: "ses_1",
  questions: [{ header: "范围", question: "修改哪些文件？", options: [], custom: true }],
}

describe("request queries", () => {
  it("loads permission and question snapshots through the typed SDK", async () => {
    const client = {
      permission: { list: vi.fn(async () => ({ data: [permission] })) },
      question: { list: vi.fn(async () => ({ data: [question] })) },
    }

    await expect(loadPermissionRequests({ client: client as never, directory })).resolves.toEqual([permission])
    await expect(loadQuestionRequests({ client: client as never, directory })).resolves.toEqual([question])
    expect(client.permission.list).toHaveBeenCalledWith({ directory }, { throwOnError: true })
    expect(client.question.list).toHaveBeenCalledWith({ directory }, { throwOnError: true })
  })

  it("filters to the active Session and gives permissions priority", () => {
    const otherPermission = { ...permission, id: "per_other", sessionID: "ses_2" }
    const otherQuestion = { ...question, id: "que_other", sessionID: "ses_2" }

    expect(selectActiveRequest([otherPermission, permission], [question, otherQuestion], "ses_1")).toEqual({
      type: "permission",
      request: permission,
    })
    expect(selectActiveRequest([], [otherQuestion, question], "ses_1")).toEqual({
      type: "question",
      request: question,
    })
  })
})
