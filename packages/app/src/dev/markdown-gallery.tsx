import { createSignal, For, onCleanup } from "solid-js"
import { render } from "solid-js/web"
import "@fontsource-variable/inter"
import "@fontsource-variable/jetbrains-mono"
import "../styles/tokens.css"
import "../styles/global.css"
import "../features/conversation/conversation.css"
import { MarkdownView } from "../features/conversation/markdown-view"
import "./markdown-gallery.css"

import { gallerySections as sections, sampleImage } from "./markdown-gallery-data"

function Gallery() {
  const prefix =
    "这一段可以先选中文字，或打开下方图片，再开始流式演示。已完成的内容将保持原节点。\n\n" +
    sections[3]!.source.split("\n\n").slice(0, 2).join("\n\n") +
    "\n\n" +
    sections[4]!.source.split("\n\n")[0] +
    `\n\n![流式更新期间可保持预览](${sampleImage})\n\n`
  const tail =
    "接下来是逐步输出的内容：中文、Markdown **加粗**、行内公式 $x^2+y^2=z^2$，以及新的段落。\n\n" + sections[2]!.source
  const [source, setSource] = createSignal(prefix)
  const [running, setRunning] = createSignal(false)
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    clearInterval(timer)
    timer = undefined
    setRunning(false)
  }
  const start = () => {
    stop()
    setSource(prefix)
    setRunning(true)
    let offset = 0
    timer = setInterval(() => {
      offset += 5
      setSource(prefix + tail.slice(0, offset))
      if (offset >= tail.length) stop()
    }, 55)
  }
  onCleanup(stop)
  return (
    <main class="gallery">
      <header class="gallery-header">
        <span>JYYCode</span>
        <h1>聊天渲染样式预览</h1>
        <p>使用项目正式组件与样式。可复制代码与公式、折叠代码、预览图片，并体验流式输出。</p>
      </header>
      <nav>
        <For each={sections}>{(section, index) => <a href={`#section-${index()}`}>{section.title}</a>}</For>
        <a href="#stream">流式演示</a>
      </nav>
      <For each={sections}>
        {(section, index) => (
          <section class="gallery-section" id={`section-${index()}`}>
            <h2 class="gallery-section-title">{section.title}</h2>
            <MarkdownView source={section.source} />
          </section>
        )}
      </For>
      <section class="gallery-section" id="stream">
        <h2 class="gallery-section-title">流式输出稳定性演示</h2>
        <div class="gallery-controls">
          <button onClick={start}>开始 / 重新演示</button>
          <button onClick={stop} disabled={!running()}>
            停止
          </button>
          <span>{running() ? "正在逐步输出…" : "已停止"}</span>
        </div>
        <MarkdownView source={source()} mode={running() ? "streaming" : "complete"} />
      </section>
    </main>
  )
}

render(() => <Gallery />, document.getElementById("root")!)
