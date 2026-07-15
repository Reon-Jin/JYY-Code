import type { QuestionRequest } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal, Show } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { QuestionPanel } from "./question-panel"

const directory = "C:\\work\\demo"
const single: QuestionRequest = {
  id: "que_single",
  sessionID: "ses_1",
  questions: [
    {
      header: "模式",
      question: "选择执行模式",
      options: [
        { label: "安全", description: "只读检查" },
        { label: "完整", description: "执行全部修改" },
      ],
    },
  ],
}

function renderQuestion(
  request: QuestionRequest,
  reply = vi.fn(async () => ({ data: true })),
) {
  const client = {
    question: {
      reply,
      reject: vi.fn(async () => ({ data: true })),
    },
  }
  const [pending, setPending] = createSignal<QuestionRequest | undefined>(request)
  render(() => (
    <Show when={pending()} keyed>
      {(value) => <QuestionPanel client={client as never} directory={directory} request={value} />}
    </Show>
  ))
  return { client, setPending }
}

afterEach(cleanup)

describe("QuestionPanel", () => {
  it("submits a single choice and stays visible until SSE confirmation", async () => {
    const user = userEvent.setup()
    const { client, setPending } = renderQuestion(single)

    await user.click(screen.getByRole("radio", { name: /完整/ }))
    await user.click(screen.getByRole("button", { name: "提交回答" }))
    expect(client.question.reply).toHaveBeenCalledWith(
      { directory, requestID: single.id, answers: [["完整"]] },
      { throwOnError: true },
    )
    expect(screen.getByRole("region", { name: "Agent 提问" })).toBeVisible()
    expect(screen.getByRole("status", { name: "问题请求状态" })).toHaveTextContent("等待服务端确认")

    setPending(undefined)
    await waitFor(() => expect(screen.queryByRole("region", { name: "Agent 提问" })).not.toBeInTheDocument())
  })

  it("supports multiple tabs, multi-select, and a custom answer", async () => {
    const user = userEvent.setup()
    const request: QuestionRequest = {
      id: "que_multiple",
      sessionID: "ses_1",
      questions: [
        {
          header: "文件",
          question: "选择文件",
          multiple: true,
          options: [
            { label: "前端", description: "修改 UI" },
            { label: "测试", description: "补充测试" },
          ],
        },
        {
          header: "备注",
          question: "补充要求",
          options: [],
          custom: true,
        },
      ],
    }
    const { client } = renderQuestion(request)

    await user.click(screen.getByRole("checkbox", { name: /前端/ }))
    await user.click(screen.getByRole("checkbox", { name: /测试/ }))
    await user.click(screen.getByRole("tab", { name: "备注" }))
    await user.type(screen.getByRole("textbox", { name: "自定义回答" }), "保持简洁")
    await user.click(screen.getByRole("button", { name: "提交回答" }))

    expect(client.question.reply).toHaveBeenCalledWith(
      { directory, requestID: request.id, answers: [["前端", "测试"], ["保持简洁"]] },
      { throwOnError: true },
    )
  })

  it("rejects the request without removing it locally", async () => {
    const user = userEvent.setup()
    const { client } = renderQuestion(single)

    await user.click(screen.getByRole("button", { name: "拒绝问题" }))
    expect(client.question.reject).toHaveBeenCalledWith(
      { directory, requestID: single.id },
      { throwOnError: true },
    )
    expect(screen.getByRole("region", { name: "Agent 提问" })).toBeVisible()
  })

  it("re-enables submission when the reply fails", async () => {
    const user = userEvent.setup()
    const reply = vi.fn(async () => {
      throw new Error("offline")
    })
    renderQuestion(single, reply)

    await user.click(screen.getByRole("radio", { name: /安全/ }))
    await user.click(screen.getByRole("button", { name: "提交回答" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("offline")
    expect(screen.getByRole("button", { name: "提交回答" })).toBeEnabled()
  })
})
