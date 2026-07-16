;(() => {
  const retryKey = "jyycode.frontend-startup-retried"
  const timeout = window.setTimeout(recoverStartup, 15_000)

  window.addEventListener(
    "jyycode:frontend-mounted",
    () => {
      window.clearTimeout(timeout)
      sessionStorage.removeItem(retryKey)
    },
    { once: true },
  )

  function recoverStartup() {
    const shell = document.querySelector('[data-startup-shell="true"]')
    if (!(shell instanceof HTMLElement)) {
      sessionStorage.removeItem(retryKey)
      return
    }

    if (sessionStorage.getItem(retryKey) !== "true") {
      sessionStorage.setItem(retryKey, "true")
      window.location.reload()
      return
    }

    shell.dataset.failed = "true"
    const title = document.createElement("strong")
    title.textContent = "界面加载失败"
    const message = document.createElement("p")
    message.textContent = "前端界面未能完成加载。请重试；如果问题持续发生，请检查开发服务器输出。"
    const retry = document.createElement("button")
    retry.type = "button"
    retry.textContent = "重新加载"
    retry.addEventListener("click", () => {
      sessionStorage.removeItem(retryKey)
      window.location.reload()
    })
    shell.replaceChildren(title, message, retry)
    retry.focus()
  }
})()
