import { render } from "solid-js/web"
import { App } from "./app"
import "./styles.css"

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"))
}

render(() => <App />, document.getElementById("root")!)
