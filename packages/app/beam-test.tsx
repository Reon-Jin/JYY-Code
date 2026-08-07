import { render } from "solid-js/web"
import { createSignal, Show } from "solid-js"
import { BorderBeam } from "./src/components/ui/border-beam"
import "./src/styles/tokens.css"
import "./src/styles/global.css"

function BeamFixture() {
  const [active, setActive] = createSignal(true)
  ;(globalThis as unknown as { __setActive: (v: boolean) => void }).__setActive = setActive
  return (
    <>
      <div class="composer-stack">
        <BorderBeam class="composer__beam" colorVariant="jyy" theme="light" borderRadius={8} active={active()}>
          <section class="composer" style={{ width: "520px", height: "120px" }}>
            <button onClick={() => setActive((v) => !v)}>toggle</button>
          </section>
        </BorderBeam>
      </div>
      <div class="multi-agent-task">
        <BorderBeam class="multi-agent-task__beam" colorVariant="jyy" theme="light" borderRadius={4} active={active()}>
          <details>
            <summary>sub agent task</summary>
          </details>
        </BorderBeam>
      </div>
    </>
  )
}

const root = document.getElementById("root")!
render(() => <BeamFixture />, root)
