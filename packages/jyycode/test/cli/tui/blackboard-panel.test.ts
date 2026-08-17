import { describe, expect, test } from "bun:test"
import {
  blackboardItems,
  kindLabel,
  authorLabel,
  type BlackboardMessage,
} from "../../../src/cli/cmd/tui/feature-plugins/system/blackboard-panel"

const message = (overrides: Partial<BlackboardMessage>): BlackboardMessage => ({
  id: "m1",
  rootSessionID: "root",
  stepID: "s1",
  authorKind: "main_agent",
  kind: "info",
  body: "hello",
  mentions: [],
  attachments: [],
  taskIDs: [],
  timeCreated: 1,
  replies: [],
  ...overrides,
} as BlackboardMessage)

describe("blackboard logic", () => {
  test("按时间正序展示", () => {
    const items = [message({ id: "a", timeCreated: 1 }), message({ id: "b", timeCreated: 3 }), message({ id: "c", timeCreated: 2 })]
    expect(blackboardItems(items).map((i) => i.id)).toEqual(["a", "c", "b"])
    expect(blackboardItems([])).toEqual([])
  })

  test("kind 标签", () => {
    expect(kindLabel("info")).toBe("信息")
    expect(kindLabel("risk")).toBe("风险")
    expect(kindLabel("blocker")).toBe("阻塞")
    expect(kindLabel("decision")).toBe("决策")
    expect(kindLabel("help")).toBe("求助")
  })

  test("作者标签", () => {
    expect(authorLabel(message({ authorKind: "user" }))).toBe("用户")
    expect(authorLabel(message({ authorKind: "main_agent" }))).toBe("主 Agent")
    expect(authorLabel(message({ authorKind: "sub_agent", authorTaskID: "t1" }))).toBe("子 Agent (t1)")
  })
})
