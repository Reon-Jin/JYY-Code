import "@fontsource-variable/inter"
import "@fontsource-variable/jetbrains-mono"
import { render } from "solid-js/web"
import { App } from "./app"
import "./styles/tokens.css"
import "./styles/global.css"

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root")

root.replaceChildren()
render(() => <App />, root)
