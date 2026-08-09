# 上下文管理与持久化记忆系统 — 内容大纲

> 目标：讲透 JYYCode 的上下文管理（Context Management）与持久化记忆（Persistent Memory）系统。
> 范围：存储结构、读写流程、记忆分层、检索逻辑、关键类与常量、安全治理、相关文档。
> 代码根：`packages/jyycode/src/`；本文所有 `file:line` 均指该目录下文件。

---

## 1. 系统总览

### 1.1 四层上下文模型（设计目标，见 `docs/plans/2026-08-07-context-memory-management.md`）

| 层 | 名称 | 内容 | 注入方式 | 触发/更新 |
| --- | --- | --- | --- | --- |
| L1 | 固定规则 | 系统提示词 + 工具描述 + 技能描述 | 每轮 system 前缀 | 基本不变 |
| L2 | 工作记忆 | 当前回合 + 最近完整回合（含工具调用与结果） | messages 尾部，保留最近 2 个真实用户回合 | 每轮变化 |
| L3 | 情景记忆 | 更早回合的累积压缩摘要（episodic digest） | system 中 `# 情景记忆` 文本，≤4000 字符 | 每 5 轮 / 接近阈值时压缩 |
| L4 | 语义记忆 | MEMORY.json（任务态）+ USER.json（用户画像）+ EXPERIENCE.json（跨会话经验） | 每轮 user turn 开始时注入有界快照 | 后台语义 curator 每回合两次提炼 |

- 四层中 L1/L2 由 `SessionCompaction`/`MessageV2` 负责，L3 由 `EpisodicMemory` 负责，L4 由 `Memory`/`ExperienceMemory` 负责。
- 子 Agent（`session.parentID !== undefined`）：不记录/不注入情景记忆；可以使用只读的 `context_read` 读取 digest、turn、search 与 experience，但不能写入持久任务/用户记忆。

### 1.2 核心模块与服务（Effect Service）

| 服务 | 文件 | 职责 |
| --- | --- | --- |
| `Memory.Service` | `memory/memory.ts` | MEMORY.json / USER.json 语义记忆（任务态 + 用户画像） |
| `ExperienceMemory.Service` | `memory/experience.ts` | EXPERIENCE.json 跨会话经验（success/failure/lesson） |
| `EpisodicMemory.Service` | `memory/episodic.ts` | 情景记忆：episodes.jsonl 无损记录 + digest 累积摘要 |
| `MemoryManagement.Service` | `memory/management.ts` | 桌面管理面 CRUD 封装（list/create/update/remove/compact/export） |
| `SessionCompaction.Service` | `session/compaction.ts` | 上下文压缩：溢出检测、预测压缩、prune、压缩执行 |
| `SessionSummary.Service` | `session/summary.ts` | 会话文件 diff 摘要（additions/deletions/files） |
| `SessionState` | `session/state.ts` | 会话滚动摘要/最近回合落盘 `.jyycode/context/<sid>.json` |
| `SystemPrompt.Service` | `session/system.ts` | 系统提示词中的 MEMORY_RULES（记忆使用规则） |
| `SessionPrompt`（runLoop） | `session/prompt.ts` | 运行循环：记忆快照注入、curator 调用、episodic 触发 |

---

## 2. 存储结构

### 2.1 全局数据目录（语义记忆，跨项目共享）

- 根目录：`Global.Path.data`（`packages/core/src/global.ts:9`，XDG data 目录下的 `jyycode`）。
- 记忆子目录：`path.join(Global.Path.data, "memory")`（`memory/memory.ts:27`）。
- 旧路径（仅 win32 迁移源）：`LEGACY_DIRECTORY = "D:/jyycode/memory"`（`memory/memory.ts:26`）。

```
<Global.Path.data>/memory/
├── MEMORY.json      # 任务态记忆：每个会话一条；同项目其他会话的任务作为只读上下文可见（schemaVersion 3）
├── USER.json        # 用户画像：稳定用户事实（schemaVersion 3）
├── EXPERIENCE.json  # 跨会话经验规则（schemaVersion 1）
└── audit.jsonl      # 所有写操作的审计日志（JSON Lines 追加）
```

### 2.2 项目级记忆（情景记忆，按项目隔离）

位于 `<workspace>/.jyycode/memory/`（`memory/episodic.ts:104-105`）：

```
<workspace>/.jyycode/memory/
├── episodes/<sessionID>.jsonl   # 每行一个已完成回合（无损原始记录，输出单条 ≤60k 字符）
└── digest/<sessionID>/
    ├── index.json               # DigestIndex { version:1, latestSeq, entries[], coveredTurns }
    └── 0001.md                  # 累积摘要（seq 递增），目标 ≤3000 字符
```

### 2.3 会话状态与数据库持久化

- 会话滚动状态：`<workspace>/.jyycode/context/<sessionID>.json`（`session/state.ts:39-41`），`SessionStateFile` 含 `summary / lastUser / lastAssistant / lastToolNames / tailStartID / turnCount`。
- SQLite（`jyycode.db`，`storage/db.ts:27`）：`session / message / part / todo / session_message / permission` 六张表（`session/session.sql.ts`）。
- JSON 存储：`<Global.Path.data>/storage/`（`storage/storage.ts:230`），如 `session_diff` 文件 diff 摘要。

### 2.4 数据结构详情

**MemoryStore（MEMORY.json / USER.json，schemaVersion=3）**（`memory/memory.ts:68-72`）
```
{ schemaVersion: 3, lastCompactedAt: "YYYYMMDD"|null, entries: [...] }
```
- TaskMemoryEntry：`{ scope:"memory", sessionID, projectID?, importance(1-10), date, keywords[1-3], content }`，键 = sessionID；projectID 仅用于把同项目其他会话的任务标记为 peer 上下文。
- UserMemoryEntry：`{ scope:"user", importance, date?, keywords[1-3], content }`，键 = 规范化 keywords 排序拼接。
- content 规则：单行（无换行）、敏感词拒绝（`looksSensitive`，`memory.ts:1718`）。
- 任务态格式（强校验 `validateTaskContent`，`memory.ts:1680`）：
  `当前任务：<goal>；进展：<progress>；[经验：<lesson>]`，goal ≤120 / progress ≤160 / 经验 ≤160 字符；禁止 `下一步`、`我用了`、`最终学会了`。

**ExperienceStore（EXPERIENCE.json，schemaVersion=1）**（`memory/experience.ts:58-62`）
```
{ schemaVersion: 1, lastMaintainedAt: "YYYYMMDD"|null, entries: [...] }
```
- ExperienceEntry：`{ scope:"experience", kind, importance, date, updatedAt, keywords, content(≤200), evidence(≤160), confidence, uses, status, sessionID, supersededReason? }`。
- kind ∈ success|failure|lesson；status ∈ active|superseded|retracted；confidence ∈ low|medium|high。
- evidence 必须以 `[sessionID#turn]` 开头（`EXPERIENCE_EVIDENCE_ANCHOR`，`experience-schema.ts:14`）。
- 键 = `sessionID + "#" + sha256(规范化 content) 前 22 位`（`experience.ts:164-166`）。

**EpisodeTurn / DigestIndex（episodic）**（`memory/episodic.ts:25-49`）
- EpisodeTurn：`{ version:1, sessionID, turn, time, userText?, files[], assistantText?, toolCalls[] }`。
- DigestEntry：`{ seq, turnStart, turnEnd, parentSeq, createdAt }`（摘要 DAG，链式累积）。

**SessionStateFile**（`session/state.ts:6-16`）：`{ version:1|2, updatedAt, lastUser?, lastAssistant?, lastToolNames?, tailStartID?, summary?, turnCount? }`。

---

## 3. 记忆分层与角色

| 记忆类型 | 文件 | 生命周期 | 写入方 | 读取方 |
| --- | --- | --- | --- | --- |
| 任务态（Task） | MEMORY.json | 每会话一条，项目内 peer 只读可见 | 语义 curator（自动）+ memory 工具（用户显式） | 每轮快照注入、memory 工具 |
| 用户画像（User） | USER.json | 长期跨会话 | 语义 curator（自动）+ memory 工具 | 每轮快照注入、memory 工具 |
| 经验（Experience） | EXPERIENCE.json | 30 天 + 用量维护 | curator 提炼的 experienceCandidates | context_read 工具、经验快照 |
| 情景（Episodic） | episodes.jsonl + digest/*.md | 会话全程 | 每回合结束 recordTurn + compactIfDue | context_read 工具、digest 注入 |
| 会话状态（SessionState） | .jyycode/context/*.json | 会话 | 每回合结束 writeSessionState | system 注入 |
| 会话/消息（SQLite） | jyycode.db | 会话 | Session 服务 | 全程 |

写入权限模型（`memory/memory.ts:451-454`）：只有主会话（`parentID === undefined`，Multi-Agent 模式下为 Planner）可写；子 Agent 写入抛 `MemoryWriteForbidden`。

---

## 4. 读写流程

### 4.1 语义记忆写入流程（自动 curator，每回合两次）

调用点（`session/prompt.ts`）：
1. **回合开始**：用户消息后 `memory.updateStepBegin(sessionID, evaluateMemoryDecision, {userText})`（`prompt.ts:1382-1396`，phase="user"）。
2. **回合结束**：助手完成时 `memory.updateAfterTurn(..., {userText, assistantText, failureHint})`（`prompt.ts:2173-2202`，phase="assistant"），并把返回的 `experienceCandidates` 交给 `experienceMemory.upsertMany`；每 20 回合触发 `experienceMemory.maintain`。

内部流程（`memory.ts:1045-1154`）：
```
updateStepBegin / updateAfterTurn
  ├─ 子 Agent? → skipped(subagent)
  ├─ 取 userText / assistantText（无合成文本的最新消息，memoryUserText/latestRealMessageText）
  ├─ evaluateSemanticUpdate(evaluator, input)   # 最多重试 2 次（带 correction 反馈）
  │    └─ LLM 语义判定：返回 MemoryDecision JSON
  │         { shouldUpdate:true, reason, task{importance,keywords,content},
  │           user[], experiences[] }（MemoryDecisionJsonSchema，memory.ts:314）
  │    └─ parseDecision + validateTaskContentForPhase 强校验
  ├─ upsertTaskMemory(decision.task)            # 必写，容量拒绝视为致命错误
  └─ forEach(decision.user) → upsertUserMemory
```
失败降级：curator 失败只记 warning，不阻断主流程（`prompt.ts:1385-1391`）。

### 4.2 结构化写入核心 `upsertStructured`（memory.ts:547-654）

1. `assertPrimaryWriter`（写保护）→ `ensure`（初始化文件）→ `EffectFlock.withLock`（进程级互斥）。
2. 读取 store → user 条目先去重合并（`deduplicateStoredUserEntries`）。
3. 敏感内容拒绝 → 计算 key → 找匹配（同 key / 等价用户事实 / 同画像槽位）。
4. 状态判定：written / duplicate / replaced；user 命中多个则 `mergeUserCandidate`。
5. 容量检查：`projected.length >= charLimit * 0.8 || entries > 50` → 自动 `compactEntrySet`；候选未被保留则返回 `capacity_rejected`。
6. 原子写：临时文件 + rename（`writeFileAtomic`，memory.ts:506）。
7. 每次写操作追加 `audit.jsonl`（memory.ts:541, 1156）。

### 4.3 工具写入（用户显式）

- `memory` 工具（`tool/memory.ts`）：actions = read | add | replace | remove | compact；target = memory | user。
  - add → `upsertTaskMemory`/`upsertUserMemory`；replace/remove 用子串唯一匹配（`findEntryBySubstring`，memory.ts:1556）；compact 确定性整理。
  - 写操作前 `ctx.ask` 权限确认（permission: "memory"）。
  - 规则强调：例行任务记忆由运行时自动更新，勿重复调用（`tool/memory.txt`）。
- 桌面管理 API（`server/routes/instance/httpapi/handlers/global.ts:189-248`）：`memoryList / memoryUserCreate / memoryUpdate / memoryRemove / memoryCompact / memoryTaskClear / memoryExport`，经 `MemoryManagement.Service`（`memory/management.ts`）落到同一份 JSON；任务态管理使用合成 sessionID `ses_desktop_management`。

### 4.4 语义记忆读取/注入流程（每轮）

`session/prompt.ts:1852-1884`（step===1 且主会话）：
```
memorySnapshot = formatWithHeader(memory) + formatWithHeader(user)
   ├─ selectSnapshotEntries：memory 取本会话条目、user 取全部，按 importance 降序，各 ≤10 条
   ├─ 截断：task ≤400 字符 / user ≤1200 字符（memory.ts:988-996）
experienceSnapshot = currentTaskKeywords → formatExperienceSnapshot(taskKeywords)
   ├─ 命中当前任务 keywords 的 active 经验，按 hits 数降序取 top-3，≤1200 字符
snapshotText = [memorySnapshot, experienceSnapshot]
system = [snapshotText?, env(仅首轮), instructions, 情景digest?, SessionState?, plan?, roleSkills?]
```
- 环境提示词仅首轮注入以省 token；记忆快照每轮刷新（`prompt.ts:1839-1847`）。
- 系统提示词记忆规则 `MEMORY_RULES`（`session/system.ts:17-24`）：不直接读 JSON、例行更新勿用工具、子 Agent 只读、禁止存密钥。

### 4.5 情景记忆流程（L3）

**记录**（回合结束，`prompt.ts:2054-2062`）：
```
episodeFromMessages(msgs + 新助手消息) → episodic.recordTurn → append 到 episodes/<sid>.jsonl
```
- `realUserTurnIndexes`：真实用户回合 = 文本(非合成)/文件/agent/subtask 消息；合成提醒与压缩占位不计数（`episodic.ts:137-152`）。

**压缩（digest）**（`prompt.ts:2063-2107`）：
```
isDigestDue(reason: "interval", totalTurns)   # 距 coveredTurns ≥5 轮
  → compactIfDue：读取未覆盖且 ≤ totalTurns-2 的回合
       buildDigestPrompt({previousDigest?, backfillText?, episodes})
       → generateDigest（独立 LLM 调用）→ 写 digest/<sid>/<seq>.md + index.json
  摘要结构（episodic-digest.ts:37-43）：
    ## 目标与约束 / ## 已完成事项与关键结果 / ## 决策与理由
    ## 遇到的问题与解决方案 / ## 待办与下一步 / ## 重要事实（精确路径、命令、错误、数字）
```
- 阈值触发：`compaction.shouldCompact` 为真时以 reason="threshold" 先行压缩（`prompt.ts:1642-1685`）。
- 首次压缩可用 `previousSummary`（SessionState 滚动摘要）或 `backfillText` 做种子回填旧历史。
- 摘要失败只记录日志，下次触发重试（`prompt.ts:2092-2095`）。

**注入与回溯**：
- digest 存在时 `historyForModel = sliceLastTurns(msgs, 5)`（保留最近 5 个真实回合原文），其余历史替换为 `# 情景记忆（已压缩的历史）` 系统文本（`episodic.ts:124-130`；`prompt.ts:1630-1641, 1885-1887`）。
- `context_read` 工具（`tool/context-read.ts`）：action = digest（最新摘要）| turn（单回合全文）| search（episodes 子串检索）| experience（经验检索）；工具在 registry 中按需懒加载（`tool/registry.ts:169-172`）。

### 4.6 上下文压缩流程（L2 → 压缩）

`SessionCompaction`（`session/compaction.ts`）：
1. **检测**：`estimateContextTokens`（文本+工具+媒体+开销，`context-estimate.ts`）；`isOverflow`（已用 token ≥ usable）；`shouldCompact`（预测式：预估输入 ≥ usable * 0.92）。
2. **触发**：runLoop 中 `result === "compact"` 或预测触发 → `compaction.create`（写入 compaction 占位用户消息，`compaction.ts:722-764`）→ 下一轮 `process`。
3. **执行**（`compaction.ts:418-662`）：
   - `select`：保留最近 `tail_turns`（默认 2）轮次，预算 `preserveRecentTokens`（usable 的 25%，2k-8k 夹取）；头部长尾交给摘要。
   - `buildPrompt`：锚定式摘要（previous-summary 更新） + `SUMMARY_TEMPLATE`（Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context/Relevant Files，`compaction.ts:68-103`）+ `<media-manifest>`。
   - 用 `mode:"compaction"` 的 assistant 消息调用 compaction agent 生成摘要（`compaction.ts:486-533`）。
   - 结果 "continue"：`tail_start_id` 落盘；auto 模式注入 `compaction_continue` 合成提示继续；overflow 模式回放最近一条真实用户消息。
4. **熔断**：连续 3 次（`AUTO_FAILURE_LIMIT=3`）自动压缩失败（含空摘要）→ 停止自动压缩并提示用户（`compaction.ts:664-685, 729-738`）。
5. **prune**：从尾部回溯，对 ≥2 轮之前的旧工具结果（除 skill 保护工具）标记 `compacted`，释放 ≥20k token（`compaction.ts:372-416`）。
6. 附属：`micro-compact`（完成工具结果的有界微压缩）与 `reactive-compact`（提示过长/媒体压力下的应急压缩）已经接入 `SessionCompaction.prepareRequest`；两者都会留下不含内容的阶段与节省量统计。

**压缩相关配置**（`overflow.ts`）：`compaction.reserved`（保留输出预算）、`trigger_ratio`（默认 0.92）、`auto:false` 可关闭、`preserve_recent_tokens`、`prune` 开关；告警/错误阈值各 20k buffer，手动压缩阻塞线 = 有效窗口 - 3k。

### 4.7 会话摘要与状态落盘

- 每回合结束：`SessionSummary.summarize`（文件 diff → summary_additions/deletions/files → 存 SQLite + `session_diff` 存储 + 事件），`SessionState.writeSessionState` 写 `.jyycode/context/<sid>.json`（`prompt.ts:2043-2052`）。
- 下一回合 system 注入 `formatSessionState`；若有 episodic digest 则省略滚动摘要与回合细节（`prompt.ts:1888-1895`）。

---

## 5. 检索逻辑

### 5.1 任务态记忆
- 键 = sessionID；每会话最多 1 条（`entryKey`，memory.ts:244）；注入快照时本会话条目置前（owner=self），同项目其他会话条目作为只读 peer 上下文一并展示，其他项目的任务不注入。

### 5.2 用户记忆去重/合并
- 规范化：NFKC + 去标点空白 + 小写（`canonicalUserContent`）。
- 画像槽位识别：姓名/生日/所在地（`userProfileFact`/`userLocationFact`，memory.ts:1299-1332）。
- 等价判定：画像同槽同值 / 规范化内容相同 / bigram 相似度 ≥0.5（`equivalentUserFacts`，memory.ts:1348）。
- 合并策略：importance 取 max、keywords 合并截 3、content 取较长者（`mergeUserCandidate`）。

### 5.3 经验检索
- 检索打分：BM25（k1=1.5、b=0.75，非负 IDF）+ 字段加权（keywords×3 / content×1 / evidence×0.5）+ 精确/包含关键词强化分；中文按字符二元组、英文按词分词，无外部依赖（experience-score.ts）。
- 自动快照查询 = 任务 keywords（权重1）+ 任务 goal 文本（权重0.5）；context_read 查询文本权重1。
- 命中 uses+1 回写仅发生在 context_read 检索路径，自动注入只读。
- 维护 `maintainStore`（experience.ts:185-241）：同 key 合并 → 30 天过期清理 → low 置信度且 uses=0 衰减 → 超 100 条/10k 字符按 `importance*100 + uses*10 + active*5` 逐条驱逐；反向经验（success↔failure）写入时把旧条目置 `superseded`（experience.ts:346-366）。

### 5.4 情景检索
- `searchEpisodes`（episodic.ts:308-332）：对 userText/assistantText/files/toolCalls 拼接文本做子串匹配，返回最近 N 条。
- `readEpisode(turn)` / `readLatestDigest`：按 turn 号 / digest index.latestSeq 直接读取。

### 5.5 上下文 token 预估
`context-estimate.ts`：每条消息开销 8 token；文本按 `chars/4`；媒体 512 token/64KB（单附件上限 32k）；工具结果计入 toolTokens；已压缩工具结果输出按占位文本计。

---

## 6. 关键常量速查表

| 常量 | 值 | 位置 |
| --- | --- | --- |
| MEMORY_CHAR_LIMIT / USER_CHAR_LIMIT | 20_000 / 2_000 | memory.ts:28-29 |
| ENTRY_LIMIT / SNAPSHOT_ENTRY_LIMIT | 50 / 10 | memory.ts:30,34 |
| CAPACITY_WARN / COMPACTION_TARGET / ENTRY_TARGET | 0.8 / 0.7 / 45 | memory.ts:31-33 |
| 快照预算（task/user） | 400 / 1200 字符 | memory.ts:35-36 |
| 任务格式限额（goal/progress/lesson） | 120 / 160 / 160 | memory.ts:40-42 |
| EXPERIENCE_CHAR_LIMIT / ENTRY_LIMIT / SNAPSHOT_TOP_K | 10_000 / 100 / 3 | experience.ts:35-38 |
| EXPERIENCE 内容/证据限额 | 200 / 160 | experience-schema.ts:12-13 |
| 经验维护间隔 | 20 回合 | experience.ts:40 |
| DIGEST_INTERVAL_TURNS / TARGET / INJECT_MAX | 5 / 3000 / 4000 | episodic.ts:12-16 |
| EPISODE 输入/输出上限 | 8_000 / 60_000 字符 | episodic.ts:13-14 |
| PRUNE_MINIMUM / PRUNE_PROTECT | 20_000 / 40_000 | compaction.ts:53-54 |
| AUTO_FAILURE_LIMIT（自动压缩熔断） | 3 | compaction.ts:60 |
| 预测压缩比例（trigger_ratio） | 0.92 | overflow.ts:7 |
| 上下文感知 autocompact buffer | 13k（≥400k 窗口 30k，≥800k 窗口 50k） | overflow.ts:22-27 |
| Token 估算（字符/令牌 / 消息开销） | 4 / 8 | token.ts:1; context-estimate.ts:5 |

---

## 7. 安全与治理

- **敏感内容拦截**：密码/密钥/令牌/API key/中文敏感词正则（memory.ts:1718-1722），memory 与 experience 写入均校验。
- **写保护**：子 Agent 只读（`MemoryWriteForbidden`，memory.ts:74-80）；工具权限 `ctx.ask("memory")` 确认。
- **容量治理**：硬上限（字符数/条目数）超限自动压缩；压缩后仍超限则 `capacity_rejected`；任务记忆必写被拒按错误处理。
- **审计**：所有 memory/experience 写操作与搜索追加 `audit.jsonl`（writerSessionID/writerKind/action/before/after）。
- **原子性与并发**：`EffectFlock` 文件级互斥 + 临时文件 rename 原子替换（concurrency 测试覆盖）。
- **降级**：curator/digest/记忆快照任一步失败仅告警，不阻断对话。
- **迁移**：旧 `D:/jyycode/memory/*.json` 与 `MEMORY.md/USER.md` 在 `ensure` 时一次性迁移并清理（memory.ts:456-494）。

---

## 8. 相关文档与测试

### 设计/计划文档
- `docs/plans/2026-08-07-context-memory-management.md`（四层上下文模型、episodic 设计、论文/开源对照）
- `docs/plans/2026-08-07-semantic-memory-optimization.md`（语义记忆优化后续计划）
- `docs/done/2026-07-05-memory-system-upgrade.md`（JSON 化存储迁移）
- `docs/done/2026-07-06-memory-system-upgrade.md`（Multi-Agent 写保护、content 格式、keywords 规范）
- `docs/done/2026-07-10-memory-double-update.md`（回合边界双更新语义）
- `docs/done/2026-07-14-user-memory-deduplication.md`（用户事实规范化去重）

### 测试（`packages/jyycode/test/memory/`）
upsert / snapshot / format / management / experience / experience-service / episodic / episodic-digest / curator / concurrency（原子写）/ compaction（容量与压缩）/ authorization（子 Agent 只读）；服务端 `test/server/global-memory.test.ts`。

---

## 9. PPT 建议素材（供后续章节使用）

1. **一张图**：四层上下文模型（固定规则/工作记忆/情景记忆/语义记忆）+ 各自的存储文件与注入点。
2. **数据流图**：用户回合 → updateStepBegin(curator) → 快照注入 → LLM → 回合结束 updateAfterTurn + recordTurn → digest；以及容量超限时的 compaction 分支。
3. **检索对比表**：任务（sessionID 精确）、用户（规范化去重）、经验（打分检索）、情景（子串检索/摘要 DAG）。
4. **关键数字墙**：20k/2k/10k 字符上限、50/100 条目、5 轮 digest、0.92 预测压缩、3 次熔断、400/1200 快照预算。
