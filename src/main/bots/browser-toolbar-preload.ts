import { ipcRenderer } from "electron"

type ToolbarState = {
  generation?: number
  url: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  instruction?: string
}

// No API is exposed to the page world, and this preload is attached only to trusted chrome.
let state: ToolbarState | undefined
let busy = false
let error = ""
let render = () => {}
ipcRenderer.on("bot-browser-toolbar-state", (_event, next: ToolbarState) => {
  state = next
  render()
})
window.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("form")!
  const address = document.querySelector<HTMLInputElement>("#address")!
  const status = document.querySelector<HTMLParagraphElement>("#status")!
  const buttons = [...document.querySelectorAll("button")]
  ipcRenderer.on("bot-browser-toolbar-focus-address", () => {
    address.focus()
    address.select()
  })
  render = () => {
    const disabled = busy || state?.generation === undefined
    for (const button of buttons)
      button.disabled =
        disabled ||
        (button.dataset.action === "back" && !state?.canGoBack) ||
        (button.dataset.action === "forward" && !state?.canGoForward)
    address.disabled = disabled
    if (document.activeElement !== address && state)
      address.value = state.url === "about:blank" ? "" : state.url
    document.querySelector("#return")!.textContent = state?.instruction ? "归还并继续" : "归还 Bot"
    status.setAttribute("role", error ? "alert" : "status")
    status.textContent =
      error ||
      (busy
        ? "正在处理…"
        : state?.instruction ||
          (state?.generation === undefined
            ? "浏览器由 Bot 控制"
            : state.loading
              ? "由你操作 · 网页加载中…"
              : "由你操作 · 关闭窗口会保留网页；完成后可归还 Bot"))
  }
  const act = async (action: string) => {
    if (busy || state?.generation === undefined) return
    const generation = state.generation
    const url = address.value.trim()
    busy = true
    error = ""
    render()
    try {
      await ipcRenderer.invoke("bot-browser-toolbar-action", { action, generation, url })
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
          : "操作失败，请重试"
    } finally {
      busy = false
      render()
    }
  }
  for (const button of buttons)
    if (button.dataset.action)
      button.addEventListener("click", () => void act(button.dataset.action!))
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    void act("navigate")
  })
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
      event.preventDefault()
      address.focus()
      address.select()
    }
  })
  render()
})
