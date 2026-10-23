const fence = "```"
export const sampleImage =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300" viewBox="0 0 800 300"><rect width="800" height="300" fill="#e7e4da"/><circle cx="620" cy="85" r="38" fill="#b19364"/><path d="M0 205L170 80 360 220 510 120 800 230V300H0" fill="#8c9a88"/><path d="M0 245L250 170 490 270 650 195 800 250V300H0" fill="#596e69"/><text x="36" y="274" font-size="24" font-family="sans-serif" fill="#f7f5ef">JYYCode · Markdown image preview</text></svg>',
  )
export const gallerySections = [
  {
    title: "文字与标题",
    source: [
      "# 一级标题：清晰的阅读层级",
      "## 二级标题",
      "### 三级标题",
      "#### 四级标题",
      "##### 五级标题",
      "###### 六级标题",
      "正文示例：中文、English、数字 123，以及 **重点内容**、*斜体*、~~删除线~~ 和 `inline code` 可以自然混排。长段落采用更舒适的字号、行高和段落间距。",
      "第二段文字与上一段保持明确间隔。金额 $20、$30 和人民币 ¥128.00 应当照常显示，不会被当成数学公式。",
      "---",
      "> 引用文字有独立的左边线。\n>\n> 引用可以包含 **强调** 和多段内容。",
    ].join("\n\n"),
  },
  {
    title: "列表、任务与提示",
    source: [
      "1. 第一项\n   - 嵌套的无序列表\n   - 第二个子项\n2. 第二项\n   1. 嵌套的有序列表\n   2. 保持清晰缩进",
      "- [x] 完成渲染检查\n- [x] 保留流式内容的节点\n- [ ] 等待用户反馈",
      "> [!NOTE]\n> 提示：正文、链接和公式可以混合使用。",
      "> [!TIP]\n> 建议：点击代码块右上角可以复制或折叠。",
      "> [!IMPORTANT]\n> 重要信息会有单独的提示样式。",
      "> [!WARNING]\n> 长公式和宽表格支持横向滚动。",
      "> [!CAUTION]\n> 格式错误的公式会保留原文。",
    ].join("\n\n"),
  },
  {
    title: "表格与列对齐",
    source:
      "| 文件 | 类型 | 用途 | 大小 |\n| :--- | :---: | :--- | ---: |\n| `dusk_lake.png` | 图片 | 最终成图 | 2.4 MB |\n| `dusk_lake.py` | Python | 绘画脚本 | 18 KB |\n| `README.md` | 文档 | **使用说明** | 3 KB |\n\n| 列一 | 列二 | 列三 | 列四 | 列五 | 列六 |\n|---|---|---|---|---|---|\n| 这是宽表格的第一列内容 | 这是第二列的长内容 | 第三列的更多说明 | 第四列继续补充 | 第五列包含详细文字 | 最后一列也有内容 |",
  },
  {
    title: "复杂数学公式",
    source: [
      "行内公式 $E=mc^2$、\\(\\alpha+\\beta=\\gamma\\)，以及根号 $\\sqrt{x^2+1}$ 与正文保持自然的基线。",
      "$$\n\\min_{B\\in\\mathbb{R}^{m\\times n}}\\|A-B\\|_F\\quad\\text{s.t.}\\quad\\operatorname{rank}(B)\\leq k.\\tag{1}\n$$",
      "\\[\n\\begin{aligned}\n\\int_{0}^{\\infty} e^{-x^2}\\,dx &= \\frac{\\sqrt{\\pi}}{2} \\\\\n\\sum_{k=1}^{n}k &= \\frac{n(n+1)}{2}\n\\end{aligned}\n\\]",
      "$$\nf(x)=\\begin{cases}\n\\sqrt{x^2+1}, & x\\geq 0 \\\\\n-x, & x<0\n\\end{cases}\n\\qquad\nA=\\begin{pmatrix}1&2&3\\\\4&5&6\\\\7&8&9\\end{pmatrix}\n$$",
      "\\[\n\\underbrace{a_1+a_2+\\cdots+a_n}_{n\\text{ 项}}\\xrightarrow{n\\to\\infty}\\sum_{k=1}^{\\infty}a_k\n\\qquad\n\\det(A-\\lambda I)=0\n\\]",
      "\\[\n\\mathcal{L}(\\theta)=\\sum_{i=1}^{N}\\left[\\frac{1}{2}\\left(y_i-f_\\theta(x_i)\\right)^2+\\lambda\\sum_{j=1}^{d}|\\theta_j|\\right]+\\underbrace{\\int_0^1\\int_0^1\\sqrt{1+x^2+y^2}\\,dx\\,dy}_{\\text{长公式横向滚动示例}}\n\\]",
    ].join("\n\n"),
  },
  {
    title: "代码块与语法高亮",
    source: [
      fence +
        'python\nfrom pathlib import Path\n\ndef greet(name: str) -> str:\n    # 中文注释保持正常显示\n    return f"Hello, {name}!"\n\nprint(greet("JYYCode"))\n' +
        fence,
      fence +
        "typescript\ninterface Result {\n  ok: boolean\n  count: number\n}\n\nconst summarize = (items: string[]): Result => ({\n  ok: items.length > 0,\n  count: items.length,\n})\n" +
        fence,
      fence + 'json\n{ "name": "JYYCode", "enabled": true, "items": [1, 2, 3] }\n' + fence,
      fence +
        "bash\n# 只执行必要的检查\nbun run typecheck\nbun run test src/features/conversation/markdown.test.ts\n" +
        fence,
      fence +
        "text\n" +
        Array.from(
          { length: 32 },
          (_, i) => `${String(i + 1).padStart(2, "0")}  长代码区域可纵向滚动，整块也可以折叠。`,
        ).join("\n") +
        "\n" +
        fence,
    ].join("\n\n"),
  },
  {
    title: "图片、链接与脚注",
    source: [
      `![山景示例，可点击放大](${sampleImage})`,
      `![夜色山景示例，可点击放大](${sampleImage.replaceAll("%23e7e4da", "%23dbe2e9").replaceAll("%23b19364", "%2394a7bc").replaceAll("%238c9a88", "%23778b93").replaceAll("%23596e69", "%234d6578")})`,
      "[打开 KaTeX 文档](https://katex.org/docs/supported.html)。链接可以用键盘访问，外部网页通过浏览器打开。",
      "这里是正文中的脚注[^example]；同一个脚注也可以再次引用[^example]。",
      "[^example]: 脚注支持 **富文本**、`代码` 和返回正文的链接。",
    ].join("\n\n"),
  },
  {
    title: "Mermaid 图表",
    source:
      fence +
      "mermaid\nflowchart LR\n  A[用户输入] --> B[解析 Markdown]\n  B --> C[数学公式]\n  B --> D[代码高亮]\n  B --> E[图片与链接]\n  C --> F[稳定显示]\n  D --> F\n  E --> F\n" +
      fence,
  },
]
