import { describe, expect, test } from "bun:test"
import {
  buildCorpusStats,
  buildQueryTerms,
  GOAL_TERM_WEIGHT,
  scoreExperience,
  tokenize,
} from "@/memory/experience-score"

const entry = (overrides: Partial<{ keywords: string[]; content: string; evidence: string }> = {}) => ({
  keywords: overrides.keywords ?? ["ssh"],
  content: overrides.content ?? "SSH 权限报错时先检查密钥权限再重试",
  evidence: overrides.evidence ?? "[ses#1] ssh -T git@github.com",
})

describe("experience BM25 scoring", () => {
  test("tokenizes ASCII words and Chinese character bigrams", () => {
    expect(tokenize("SSH 权限")).toEqual(["ssh", "权限"])
    expect(tokenize("赛车游戏")).toEqual(["赛车", "车游", "游戏"])
    expect(tokenize("部署前先跑测试")).toEqual(["部署", "署前", "前先", "先跑", "跑测", "测试"])
    expect(tokenize("")).toEqual([])
  })

  test("buildQueryTerms weights task keywords above goal text", () => {
    const terms = buildQueryTerms(["认证"], "认证中间件回归")
    expect(terms.get("认证")).toBe(1)
    expect(terms.get("中间")).toBe(GOAL_TERM_WEIGHT)
    expect(terms.get("回归")).toBe(GOAL_TERM_WEIGHT)
  })

  test("idf ranks rare terms higher than common terms", () => {
    const stats = buildCorpusStats([
      entry({ keywords: ["ssh"], content: "ssh 报错", evidence: "ssh" }),
      entry({ keywords: ["部署"], content: "部署前先跑测试", evidence: "npm test" }),
      entry({ keywords: ["部署"], content: "部署脚本先看日志", evidence: "deploy.sh" }),
    ])
    expect(stats.idf("部署")).toBeLessThan(stats.idf("ssh"))
    expect(stats.idf("不存在词")).toBeGreaterThan(0)
  })

  test("exact keyword match outranks content-only match", () => {
    const docs = [
      entry({ keywords: ["ssh"], content: "无关内容", evidence: "无" }),
      entry({ keywords: ["部署"], content: "ssh 权限问题处理", evidence: "无" }),
    ]
    const stats = buildCorpusStats(docs)
    const terms = buildQueryTerms(["ssh"], "")
    const exact = scoreExperience(docs[0]!, terms, ["ssh"], stats)
    const contentOnly = scoreExperience(docs[1]!, terms, ["ssh"], stats)
    expect(exact).toBeGreaterThan(contentOnly)
  })

  test("containment boost matches 赛车游戏 against keyword 赛车", () => {
    const docs = [entry({ keywords: ["赛车"], content: "完成赛车游戏", evidence: "无" })]
    const stats = buildCorpusStats(docs)
    const terms = buildQueryTerms(["赛车游戏"], "")
    const score = scoreExperience(docs[0]!, terms, ["赛车游戏"], stats)
    expect(score).toBeGreaterThan(0)
  })

  test("unrelated query scores zero", () => {
    const docs = [entry({ keywords: ["ssh"], content: "SSH 权限", evidence: "无" })]
    const stats = buildCorpusStats(docs)
    const terms = buildQueryTerms([], "闲聊")
    expect(scoreExperience(docs[0]!, terms, [], stats)).toBe(0)
  })
})
