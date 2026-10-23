export async function openExternalUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsupported link")
  if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("open_external_url", { url: url.href })
    return
  }
  window.open(url.href, "_blank", "noopener,noreferrer")
}
