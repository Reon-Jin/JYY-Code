# JYYCode 视觉定位与 Jev 动作选择 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 JYYCode 快速读取真实桌面画面、精确定位可操作组件，并让 Jev 在视觉生成的合法“动作种类＋坐标”候选中选择，再由现有原生执行器完成动作。

**Architecture:** 主 LLM 保留视觉理解和任务意图；桌面宿主在原始像素截图上并行获取无障碍信息与视觉检测结果，融合为带边界框和落点的候选。Jev 只接收候选的文字/JSON 描述并返回一个候选 ID；宿主复查窗口、画面版本和落点后执行，并返回新截图。视觉检测器漏检时用局部放大/视觉模型补候选，仍不让 Jev 猜裸坐标。

**Tech Stack:** Bun/TypeScript/Effect、现有 `computer` 工具、Windows UIA/Win32、macOS AX/Quartz、可选本地常驻视觉解析器（先评测 OmniParser v2）、TypeSafe Jev API。

---

## 0. 本次需求修正与技术事实

当前目标是**单个电脑动作的速度与定位精度**：看见画面、发现按钮/输入框/菜单等可操作目标、选择动作及坐标并立即执行。主 LLM 的高层任务规划能力、通用任务成功率与跨应用工作流不作为本次升级目标。

Jev `jev-1.13.0` 的输入是文本或 JSON，**没有图片输入**；Choice 在最多 255 个预设项中选择，不能产生任意新数值坐标。[TypeSafe 模型](https://docs.typesafe.ai/models)、[API 契约](https://docs.typesafe.ai/api)。因此“让 Jev 选择坐标”的可实施含义是：视觉层先提出坐标，代码把每个动作与坐标组成候选（例如 `c17 = click(742,316)`），Jev 返回 `c17`。如果要求 Jev 单独对截图回归出任意 `(x,y)`，目前模型能力不支持。

“画面中的**所有**组件”也无法由任何单一视觉模型保证：自绘画布、遮挡、半透明控件、无标签图标和极小按钮均可能漏检。目标应设为“对支持的画面尽可能完整地列举；有漏检迹象就放大/补检；在无法证明落点时停下而不是乱点”。

## 1. 当前实现：可保留的能力与直接问题

| 路径 | 已有能力 | 对本目标的限制 |
| --- | --- | --- |
| `packages/jyycode/src/tool/computer.ts` | Desktop 单 Agent 根会话工具；`computer` 许可；操作后附截图；`observe/click/scroll/key/type/drag/wait/batch`。 | 主 LLM 仍要从图像或最多 160 个 UIA/AX 控件中自行挑点；没有本地视觉组件索引和 Jev 选择。 |
| `packages/jyycode/src/tool/computer/native.ts` | 参数验证、屏幕到桌面坐标变换、串行执行；默认将截图缩到 1280×800，高清到 2000×1400。 | 缩图会丢小图标细节；视觉检测需要原始分辨率截图与严格的坐标映射。 |
| `packages/jyycode/src/tool/computer/windows.ps1` | GDI 全桌面截图、UIA 控件树、`SendInput` 原生输入；Windows helper 常驻。 | UIA 不覆盖所有可见按钮；每次都截图，扫树和 PNG 编码在同一串行请求内。 |
| `packages/jyycode/src/tool/computer/macos.swift` | AX、Quartz、打包 helper。 | 进程 PID 被当作窗口 ID；同应用切窗口不能阻止错点；helper 每次调用冷启动。 |
| `packages/jyycode/src/session/message-v2.ts` | 旧截图分组清理，保留近期视觉上下文。 | 可继续使用，无需因 Jev 接入删除。 |

之前同机记录：Windows 温态 `observe` 约 340–365 ms，不扫控件的截图约 180 ms，元素点击加曲线约 622 ms（见 `docs/plans/2026-09-22-desktop-computer-control.md` 与 `2026-09-23-computer-control-grounding.md`）。这些是旧 helper 时间，**不包括视觉检测与 Jev 网络**。本机 `nvidia-smi` 显示 RTX 4060 Laptop GPU、8188 MiB 显存；它可作为本地视觉解析器的首个测试硬件，不能据此假定所有用户都具备 GPU。

## 2. 与视觉定位直接相关的开源证据（截至 2026-09-25）

| 项目 | 对本方案的价值 | 速度/精度约束 |
| --- | --- | --- |
| [Microsoft OmniParser](https://github.com/microsoft/OmniParser) | 截图交互区域检测、文字/图标描述；2026-07 增加 YOLOv9-E 检测权重；可以产出图像上的区域候选。 | 项目公布的 OmniParser v2 ScreenSpot-Pro 结果约 39.5%，无法据此承诺“全按钮精确识别”；本机冷/热推理必须实测。新检测权重与早期 Ultralytics 权重许可不同，选用前核对模型和代码许可。 |
| [Microsoft GUI-Actor](https://github.com/microsoft/GUI-Actor) | 对**给定目标描述**做精准视觉定位，是检测漏项时的二级定位候选。 | 偏单目标 grounding，不能替代全画面组件枚举；VLM 推理可能比检测器慢。 |
| [OpenAdapt grounding](https://github.com/OpenAdaptAI/openadapt-grounding) | 借鉴多帧稳定化、缓存、从便宜到昂贵的定位阶梯。 | 仓库将其标为研究状态；示例解析可能数秒，不可未经本机基准就放到每次动作的热路径。 |
| [RegionFocus](https://github.com/tiangeluo/RegionFocus)、[论文](https://openaccess.thecvf.com/content/ICCV2025/papers/Luo_Visual_Test-time_Scaling_for_GUI_Agent_Grounding_ICCV_2025_paper.pdf) | 小图标/高分辨率界面的按需裁剪放大思路。 | 多次模型调用可提升定位，但直接牺牲速度；只能在粗定位不可信时使用。 |
| [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) | 动态候选表、一次 Jev 请求选操作/目标、执行前核对和失败后再观察。 | 是浏览器 DOM，不会自动解决 Windows/macOS 原生截图定位；其 25% 提速数据比较的是两版 Jev 运行时的一个浏览器任务。[测量说明](https://github.com/browser-use/jev-ultrafast/blob/main/docs/performance.md)。 |

**选择：** 不直接移植第三方电脑操控运行时。先复用 JYYCode 原生截图与执行器，以 OmniParser 类的交互区域检测为可替换组件，UIA/AX 和 OCR 补标签，主 LLM/VLM 负责复杂画布或漏检目标。视觉解析器的具体实现以本机速度、组件覆盖和许可检查决定。

## 3. 新版操作方式

### 3.1 对外接口与数据形状

保留全部旧 `computer` 动作，新增 `action: "choose"`：

```ts
type ChooseInput = {
  action: "choose"
  intent: string                    // 单个可见动作，例如“点击右上角保存按钮”
  literalText?: string              // 仅当选中 type 候选时使用，不交给 Jev 生成
  allowedActions?: Array<"click" | "double_click" | "right_click" | "scroll" | "type" | "key" | "drag">
  resolution?: "standard" | "high"
}
type VisualTarget = {
  id: string
  frameID: string
  kind: "button" | "input" | "menu" | "link" | "icon" | "scrollable" | "canvas" | "unknown"
  box: { x: number; y: number; width: number; height: number } // 原始截图像素
  label?: string
  source: Array<"uia" | "ax" | "ocr" | "detector" | "caption">
  visibility: "visible" | "occluded" | "uncertain"
  confidence: number               // 定位器分数；不能与 Jev 概率混为一谈
}
type ActionCandidate = {
  id: string                        // 中性、仅本帧有效的 ID
  frameID: string
  action: NonNullable<ChooseInput["allowedActions"]>[number]
  targetID?: string
  point?: { x: number; y: number }  // 原始截图像素；Jev 只选此预计算值
  endPoint?: { x: number; y: number }
  literalText?: string
}
```

`choose` 返回所选 `{action, screenshotX, screenshotY, targetID, frameID, reasonCode}` 和**执行后的新截图**。旧直接动作继续接受最近截图坐标。主 LLM 可直接看到干净截图；可选 `annotate=true` 才叠加候选框，避免标签遮住小按钮。若 Jev 低置信度、视觉未发现目标或窗口变化，返回 `needs_vision` 并把截图交回主 LLM；绝不任选附近坐标。

`choose` 的 `intent` 是下一步可见动作，不引入复杂的长期任务目标、完成声明、跨应用规划或独立任务评测。若要连续执行几个确定性动作，继续用已有 `batch`；每个不确定动作重新观察再决定。

### 3.2 视觉观察与候选生成

1. **抓取：** 原生 helper 一次抓取全分辨率图像，记录 `frameID`、虚拟桌面原点、每块屏幕的 bounds/DPI、真实前台窗口 ID。原始图只在进程内用于检测；发给 LLM 的图像可按现有标准压缩。检测器不能以压缩后的 1280×800 图作为唯一输入。
2. **并行感知：** UIA/AX 控件扫描和截图后的视觉检测并发运行；OCR 从图像提取文字与位置。视觉检测器要覆盖 UIA 缺失的图标、自绘按钮；UIA/AX 提供更准的文字、role 和 enabled 状态。重叠区域用 IoU/文字/几何关系融合，保留来源与冲突标志，不将两个独立按钮误并。
3. **无标签图标：** 先查看附近文字、tooltip 和无障碍名；仍无标签时对图标小裁剪使用本地 caption 模型并按 crop 哈希缓存。只有缺失且与 `intent` 相关的区域进入 VLM/局部放大路径，避免整屏每帧做昂贵 caption。
4. **小目标：** 对高 DPI/分辨率大于检测器输入上限的画面，先保留原图分块/重叠 tile 检测，再按 crop offset 回映射；必要时二次放大。记录本次搜索范围和是否 `truncated`，不能把“没检出”误报为“画面没有”。
5. **动作候选：** 代码从组件类型和 `allowedActions` 组合出合法动作；按钮优先 click，输入框可 click/type，滚动区可 scroll。点位取可见安全内区而非盲目 bbox 中心：避开边界、遮挡、相邻热区；系统控件可用 UIA ElementFromPoint/AX hit-test 核对。拖拽起止点必须来自视觉/VLM 的明确轨迹建议；Jev 不能创造中间曲线。
6. **容量：** 典型屏幕只提供相关动作候选（建议最多 64 个，加 `NONE`/`NEED_VISION`）；若超过 Jev 的 255 项硬限制，先由确定性文本匹配和区域筛选缩小，或两级“区域→目标”选择。筛选必须记录被排除范围，目标可能在范围外时允许再查，绝不静默裁掉。

**Jev 请求示意：**

```json
{
  "model": "jev-1.13.0",
  "state": {"intent": "点击保存按钮", "window": "画图", "candidates": [
    {"id": "c17", "action": "click", "label": "保存", "box": [720, 300, 44, 28], "point": [742, 314], "sources": ["uia", "detector"]}
  ]},
  "questions": {"next": {"type": "choice", "instructions": "选择最符合 intent 的当前可见动作候选；找不到则选 NEED_VISION", "criteria": {"c17": "click 保存按钮，位于画图窗口工具栏", "NEED_VISION": "候选中没有可信目标"}}}
}
```

Jev 选择整个 `c17`，宿主才取得 `click` 和 `(742,314)`。不得把 `action` 与 `target` 分成两道互不约束的选择。选项 ID 保持中性，避免语义标签偏置；[近期研究](https://arxiv.org/abs/2609.26758)表明类型有效不代表选项语义判断正确。

### 3.3 输入守卫与回退

- 最后一次截图、UIA/AX、OCR、检测器结果共享 `frameID`；任何候选只能用于该帧。执行前复查前台**窗口**、屏幕拓扑、目标仍可见、落点仍位于目标内且未被覆盖。Windows `click/scroll/drag` 已有窗口守卫，补齐 `key/type`；macOS 改掉“同 PID 即同窗口”的判断。
- 禁止直接执行 UI 文本中的命令。所有坐标仍由宿主从截图像素映射到物理桌面/Quartz 点；多显示器负原点、非整数缩放和局部 crop offset 用同一转换函数测试。
- 检测结果空白、冲突或 Jev 不确定时，优先只裁剪相关区域提高分辨率；若仍无法定位，回传截图给主 LLM 使用现有视觉动作。视觉能力始终存在，不以 AX 覆盖率决定是否允许操作。
- 原生动作发出后获取新截图供主 LLM 继续工作。对明显异常（前台跳走、点击落点偏移、图片无变化）返回 `blocked/uncertain`；本次不建立复杂任务验收器。
- 默认不向 Jev 发送整张图、密码字段值、与本次动作无关的窗口文本；其文本/JSON 通道仅接收候选摘要。TypeSafe 网络不可用时继续使用旧的视觉直调模式。

### 3.4 速度设计与可量化标准

**热路径：** 复用 Windows 常驻 helper；视觉模型作为常驻进程一次加载，避免每动作启动 Python/加载权重。截图与 UIA 并发，OCR 和视觉检测器在每个变化的画面上并行启动：若 UIA/OCR 已给出唯一且可验证的目标，可在检测器完成前继续；若缺失或冲突，则等检测器结果。caption/二次放大只在标签不足时触发。对未变化的窗口区域做 tile 哈希缓存，但每次点击前仍确认该区域未变化。原始图像尽量通过共享内存/本地文件句柄交视觉 worker，避免多次 base64 编码。Jev 请求仅发紧凑候选表，使用 `jev-1.13.0` 固定版本；在本地网络实测后设超时，超时立刻回退，不让用户等待多轮指数退避。

先测本机 RTX 4060 8 GB 下各阶段的 warm/cold p50/p95：`capture`、UIA、OCR、detector、caption、Jev 请求、guard/input、回传 PNG，以及总“新截图→正确动作→新截图”延迟。**工程目标而非已实现性能：** 常见有标签按钮热态 p50 ≤ 1 秒、p95 ≤ 2 秒；视觉专属小图标的慢路径单独统计。若重型检测器让常见按钮超标，利用上述并行与提前结束规则，但不得在目标只有视觉证据时跳过视觉定位。

定位基准使用录制截图与真实点击区域标签，分别报告：组件召回率（按钮/输入框/菜单/图标，按大小和 UIA 可用性分层）、被选目标的框命中率、最终点击点命中率、漏检率、误点率、主动 abstain 率。不能用“任务最终完成”代替定位指标。发布门槛先要求**误点率相对现有视觉直调不升高**、焦点和旧帧故障注入 100% 在输入前拦截；召回和时延阈值由真实基线与设备档位确定，不能编造“识别所有按钮”的保证。

## 4. 代码结构与旧版清理

```text
packages/jyycode/src/tool/
  computer.ts                      # 保留唯一工具入口、Session/Permission 门禁；新增 choose
  computer/
    native.ts                      # 保留 Action/Observation、坐标映射与平台调用
    frame.ts                       # 新：原始截图、屏幕几何、窗口身份、frameID
    vision.ts                      # 新：视觉解析器协议、常驻 worker、失败回退
    fuse.ts                        # 新：UIA/AX + OCR + detector 框融合、候选框
    candidate.ts                   # 新：动作+坐标闭集与安全落点
    jev.ts                         # 新：TypeSafe HTTP 调用与严格响应校验
    choose.ts                      # 新：单步观察→感知→选择→守卫→执行
    windows-worker.ts/windows.ps1  # 保留；增加原图/窗口/键盘守卫支持
    macos.swift                    # 保留；修正窗口身份、原图输出
packages/jyycode/test/tool/
  computer.test.ts                 # 保留并扩充直调兼容测试
  computer-frame.test.ts           # 新：多屏、DPI、crop/tile 坐标
  computer-vision.test.ts          # 新：检测融合、漏检、遮挡、缓存
  computer-choose.test.ts          # 新：Jev 选择、旧帧、焦点、回退
packages/jyycode/script/
  computer-grounding-bench.ts      # 新：图片定位与单动作延迟测量
packages/desktop/README.md        # 更新能力/坐标/速度模式说明
```

**明确清理范围：**

1. 新 `frame.ts` 对 session 生命周期和 frame 版本负责后，删除 `computer.ts` 的裸 `frames: Map` 和重复的“上一张图”状态。旧 `observe/click/.../batch` 仍经同一个 FrameStore，可作为视觉回退。
2. `native.ts`、`windows-worker.ts` 当前各有串行队列；证明单一全局输入锁能覆盖两个平台、取消与 worker 重启后，删除重复的一层。坐标换算只保留一套函数。
3. 不删除 `windows.ps1`、`macos.swift` 或截图附件逻辑；它们是新版快速原生执行和视觉能力的基础，不是应清理的废弃代码。只移除旧的 UIA-only 编号点击特殊状态、过期文案和被 FrameStore 取代的代码。
4. 修正 `packages/desktop/README.md` 中“默认标注截图”“原生坐标”等与当前实现不符的说明；保留旧历史计划作为历史记录，但以本文为现行方案。检查 `computer-assets.d.ts`、Tauri helper 打包、权限配置和单元测试的引用后再移除任何资产声明。

## 5. 实施任务（每项按失败测试→最小实现→通过→提交）

实施时遵守 `packages/jyycode/AGENTS.md` 和 `packages/jyycode/test/AGENTS.md`；在独立 `codex/` 工作树中编码。以下命令中的 `bun test` 从 `packages/jyycode` 执行，根目录命令另有说明。视觉模型不要直接下载进 Git 仓库；记录版本、权重哈希、许可和本地缓存目录。

### Task 1：固定现有截图与动作基线

**Files:** Create `packages/jyycode/script/computer-grounding-bench.ts`, `packages/jyycode/test/tool/computer-frame.test.ts`。

1. 收集可公开的 Windows 原始截图/点击框夹具，含 100%/150%/200% DPI、双屏负原点、中英文、小图标和遮挡；截图只作测试数据，不采集用户私人画面。
2. 写坐标失败测试：原图与 tile/crop → 桌面来回转换，原始像素落点误差 ≤ 1 物理像素；缩图坐标另按缩放比例测试量化误差，不能要求它恢复被丢掉的原始像素。运行 `bun test --timeout 30000 test/tool/computer-frame.test.ts`，预期先失败。
3. 基准脚本加入 `--dry-run`、阶段计时与 JSONL 输出；运行 `bun run script/computer-grounding-bench.ts --dry-run`，预期不移动鼠标。提交 `test: capture computer grounding baseline`。

### Task 2：原始帧与统一坐标

**Files:** Create `packages/jyycode/src/tool/computer/frame.ts`; Modify `computer/native.ts`, `computer/windows.ps1`, `computer/macos.swift`; Test `computer-frame.test.ts`。

1. 写 `Frame {id, capturedAt, virtualScreen, monitors, foregroundWindow, rawImageSize, displayImageSize}` 测试；旧截图坐标仍兼容。
2. helper 提供全分辨率视觉输入和可压缩的 LLM 输出两种视图，共享 frameID；tile 保存原图 offset/scale。统一 `imagePointToDesktop` 与 `tilePointToImage`；旧直调使用同一映射。
3. 运行 `bun test --timeout 30000 test/tool/computer-frame.test.ts test/tool/computer.test.ts`，预期全部通过。提交 `feat: preserve native-resolution computer frames`。

### Task 3：视觉检测器速度与许可探针

**Files:** Create `packages/jyycode/src/tool/computer/vision.ts`, `packages/jyycode/script/computer-vision-probe.ts`; Test `computer-vision.test.ts`。

1. 做可替换 `VisualParser.parse(frame, region?, signal)` 协议和假解析器测试，不在正式产品硬编码 Python/模型路径。
2. 在本机 8 GB GPU 上用常驻进程测试 OmniParser v2（含 2026 YOLOv9-E）、OCR 与可选 caption 的首次/热态延迟、显存、图标召回和许可；记录权重哈希。若 CPU/低显存不可用，定义 `vision_unavailable` 回退而非等待超时。
3. 为模型 worker 加健康检查、一次加载、请求取消与重启；运行 `bun test --timeout 30000 test/tool/computer-vision.test.ts`。提交 `feat: add pluggable visual parser`。

### Task 4：UIA/AX、OCR、检测框融合

**Files:** Create `packages/jyycode/src/tool/computer/fuse.ts`, `candidate.ts`; Modify `windows.ps1`, `macos.swift`; Test `computer-vision.test.ts`。

1. 失败测试覆盖同名按钮、嵌套框、OCR 与 UIA 错位、遮挡、未标注小图标、>160 个控件、>255 个动作候选。
2. 实现保留来源的框融合、安全内区点位、可见性与 `truncated` 状态；无标签 icon 的 caption 按 crop 哈希缓存，超高分辨率用 tile 检测。
3. 生成 `ActionCandidate` 的动作与坐标整体项；按 `intent` 相关性预筛，不适用动作不出现在候选集。运行 `bun test --timeout 30000 test/tool/computer-vision.test.ts`。提交 `feat: ground visual actions to pixel candidates`。

### Task 5：Jev 一次选动作与坐标

**Files:** Create `packages/jyycode/src/tool/computer/jev.ts`, `choose.ts`; Modify `packages/jyycode/src/tool/computer.ts`, `src/effect/runtime-flags.ts`; Test `computer-choose.test.ts`。

1. 用假 TypeSafe 端点写失败测试：合法 Choice、未知 ID、低置信度、空候选、429/超时、候选动作与坐标不匹配、Jev 没有 key；异常不得执行鼠标。
2. `choose` 只发送短的候选 JSON，使用 `jev-1.13.0` 和 `TYPESAFE_API_KEY`；实验开关 `JYYCODE_EXPERIMENTAL_COMPUTER_JEV`。严格确认返回 ID 属于最新 frame 的候选，随后校验窗口、目标和安全落点。
3. 执行所选动作并回传新截图；失败返回 `needs_vision`。运行 `bun test --timeout 30000 test/tool/computer-choose.test.ts test/tool/computer.test.ts`。提交 `feat: let Jev select grounded desktop actions`。

### Task 6：精度守卫、视觉补检与双平台验证

**Files:** Modify `frame.ts`, `fuse.ts`, `choose.ts`, `windows.ps1`, `macos.swift`; Test 上述三个新测试文件。

1. 对旧帧、窗口切换、屏幕缩放变化、落点被遮挡写失败测试；`key/type` 同样校验前台，macOS 用真实窗口身份而非应用 PID。
2. 在候选漏检/低分时启用区域放大或 GUI-Actor/VLM 目标定位作为可关闭补检，只有新候选重新通过宿主 guard 才可执行。补检耗时单独标为慢路径。
3. Windows 做真实鼠标/键盘探针；Mac CI 编译并在 Mac 真机测试窗口切换、TCC 和多显示器。运行 `bun test --timeout 30000 test/tool/computer-frame.test.ts test/tool/computer-vision.test.ts test/tool/computer-choose.test.ts`。提交 `fix: reject stale or ungrounded computer input`。

### Task 7：清理旧代码、基准和放量

**Files:** Modify `computer.ts`, `computer/native.ts`, `computer/windows-worker.ts`, `packages/desktop/README.md`; Modify `computer-grounding-bench.ts`。

1. 按第 4 节引用清单删除已替代状态/重复队列/过期文案；保留旧直接动作与视觉截图回退。运行 `rg -n 'frames|runExclusive|native desktop coordinates|annotated screenshot' packages/jyycode/src/tool/computer.ts packages/jyycode/src/tool/computer packages/desktop/README.md`，人工确认每处剩余引用均必要。
2. 将基准在相同截图和机器上交替测旧视觉直调、新 UIA/OCR 快路径、新本地检测路径、新二级补检；输出定位精度、误点和阶段 p50/p95。只在满足第 3.4 节目标且不增加误点时将 Jev 路径设为默认；否则保持开关试点。
3. 运行 `bun run --cwd packages/jyycode typecheck`、相关 Bun 测试、仓库根 `bun run check:ci`、Windows sidecar smoke、macOS 构建/现场测试、`git diff --check`。提交 `refactor: retire superseded computer state and document visual Jev mode`。

## 6. 发布判断

应先做**视觉候选生成＋Jev 封闭选择**的原型，因为它符合“Jev 选择动作与坐标”的真实能力边界；但不要预先承诺任意屏幕、全部按钮、所有硬件同时达到亚秒级。发布时给用户三条明确路径：`choose` 快速结构化选择、原有直接视觉动作、局部放大/视觉补检。每条路径都有可观测的耗时和定位结果，无法可靠定位时立即退回截图由主 LLM 处理。

## 7. 实施与试点评估（2026-09-25）

已实现原始帧及统一坐标、UIA/AX 与检测框融合、按需 OCR、候选动作表、TypeSafe Jev 封闭选择、执行前窗口/目标守卫、视觉失败回退、模型常驻进程和旧帧状态清理。旧 `observe/click/...` 和干净截图继续可用。Windows helper 的内部请求队列与工具入口的事务锁仍各有用途：前者保护独立调用 `runNative` 的进程协议，后者让一次 `choose` 的多次观察和最终输入不与其他工具调用交错；因此没有盲删其中一层。

本机使用 `microsoft/OmniParser-v2.0` 修订 `f55d0750e5b94db2125ef0b45b0fa4a85ddc59b4` 的 `icon_detect_v3/model.pt`，SHA-256 为 `11c6cbb77f22569fab22d86c76407a83ec81ab89dbfe28279854822d6e3fb00c`。权重仅存于用户 Hugging Face 缓存，不进入仓库。该权重模型卡标记 MIT；若再分发，需重新核对代码、模型及所有依赖许可。RTX 4060 Laptop 8 GB 上，模型冷加载约 10.8–12.0 秒；常驻后可重复推理。

用 [ScreenSpot-Pro 官方数据集](https://huggingface.co/datasets/likaixin/ScreenSpot-Pro)中的 16 张 Windows 截图、16 个标注目标做了**小样本、视觉检测单层**测试；判定标准是检测框中心落入标注点击框。结果不包含 UIA、OCR、Jev、真实点击或任务完成率：

| 视觉路径 | 命中 | icon | text | 检测 p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| 整屏缩放检测 | 7/16 | 5/8 | 2/8 | 221 / 348 ms |
| 全屏重叠分块检测 | 15/16 | 8/8 | 7/8 | 1384 / 2350 ms |

这说明全屏检测器热态够快，但高分辨率小组件的召回不足；分块显著改善该样本的覆盖率，却不能作为每次点击的快速热路径。`choose` 因此先走可唯一核实的 UIA/AX 目标，否则运行整屏检测；Jev 主动弃权后才做局部 OCR 与分块补检。没有文字/无障碍名的图标无法仅靠 Jev 的文本接口理解语义，仍交回主视觉模型。EasyOCR 在同机 2560×1600 真实桌面整屏约 3.2 秒，故不放在每个动作的热路径。

**放量状态：保持实验开关关闭。** 尚缺真实 TypeSafe 凭证下的 Jev p50/p95 与端到端时延、足够规模的交替定位/误点基线、Windows 实际输入探针、macOS 真机 TCC/多显示器验证。现阶段不能宣称达到常见按钮 p50 ≤ 1 秒，也不能宣称识别画面中的所有组件。Mac helper 已加入 CI 编译，真机操作仍需单独验收。为优先保证速度和避免误点，暂未把图标 caption/GUI-Actor 加入常规路径；需要无标签图标语义时回退到保留的主 LLM 截图视觉能力。
