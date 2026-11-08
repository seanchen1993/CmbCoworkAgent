/* Browser-only fixture. Transport stubs never write scrollTop or implement controller policy. */
/* eslint-disable @typescript-eslint/ban-ts-comment -- esbuild virtual module and browser-only probes */
// @ts-nocheck -- fixture:thread is an esbuild-only deterministic transport module.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ChatContainer } from "../../src/renderer/src/components/chat/ChatContainer"
import { useAppStore } from "../../src/renderer/src/lib/store"
import { threadStore, streamStore } from "fixture:thread"

const noop = () => {}
const asyncNoop = async () => null
const defaults = {
  getAll: () => ({}),
  getAllMetadata: () => ({}),
  getEnabledSources: () => [],
  list: () => [],
  listModels: () => [],
  getStatus: () => ({}),
  getConfig: () => ({}),
  getYoloMode: () => false,
  isCoordinatorModeForced: () => false
}
const native = (path = "") =>
  new Proxy(
    function () {
      return undefined
    },
    {
      get: (_, name) => (name === "then" ? undefined : native(path + "." + String(name))),
      apply: () => {
        const name = path.split(".").at(-1)
        if (name.startsWith("on")) return noop
        if (path.endsWith(".skills.getDisabled")) return Promise.resolve([])
        if (path.endsWith(".mods.chatDisplayCapability")) return Promise.resolve(false)
        if (path.endsWith(".mods.commands")) return Promise.resolve([])
        if (path.endsWith(".hooks.logging.get")) return Promise.resolve({ enabled: false })
        return Promise.resolve(defaults[name]?.() ?? null)
      }
    }
  )
window.api = native()
window.electron = { process: { platform: "win32" }, openExternal: asyncNoop }
useAppStore.setState({
  accountRevision: 1,
  currentThreadId: "following-a",
  mainView: "thread",
  threads: ["following-a", "following-b"].map((thread_id) => ({
    thread_id,
    title: thread_id,
    created_at: 1,
    metadata: { workspacePath: "C:/fixture" }
  })),
  models: [{ id: "test", name: "Fixture model", model: "fixture", available: true }],
  pluginVersion: 0,
  rightPanelCollapsed: true,
  loadThreads: asyncNoop,
  loadModels: asyncNoop,
  patchThreadMetadata: asyncNoop,
  generateTitleForFirstMessage: noop
})
const root = createRoot(document.getElementById("root"))
const frames = async (count) => {
  // A RAF promise resumes in a microtask before native ResizeObserver delivery. Queue a
  // task from RAF instead, so frame-boundary geometry includes that frame's layout delivery.
  // This observes DOM geometry and does not claim compositor/presentation timing.
  for (let i = 0; i < count; i++) {
    await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)))
  }
}
const viewport = () => document.querySelector("[data-radix-scroll-area-viewport]")
const sample = () => {
  const parent = viewport(),
    rect = parent.getBoundingClientRect()
  const dialog = document
    .querySelector('[role="dialog"][aria-labelledby="user-input-dialog-title"]')
    ?.getBoundingClientRect()
  const question = document.querySelector("[data-user-input-content]")
  const inputRange = document.createRange()
  if (question) inputRange.selectNodeContents(question)
  const inputReadable =
    !!question &&
    [...inputRange.getClientRects()].some(
      (box) =>
        box.width > 0 &&
        box.bottom > rect.top &&
        box.top < rect.bottom &&
        box.bottom > dialog.top &&
        box.top < dialog.bottom
    )
  const readable = [...parent.querySelectorAll("[data-readable-body]")]
    .filter((node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      return (
        [...range.getClientRects()].some((box) => box.bottom > rect.top && box.top < rect.bottom) &&
        getComputedStyle(node).visibility !== "hidden" &&
        !node.closest('[inert],[aria-hidden="true"]')
      )
    })
    .map((node) => node.closest("[data-chat-message-id]").dataset.chatMessageId)
  return {
    top: parent.scrollTop,
    gap: parent.scrollHeight - parent.clientHeight - parent.scrollTop,
    height: parent.clientHeight,
    readable,
    inputReadable,
    dialogTop: dialog?.top,
    dialogHeight: dialog?.height,
    tailBottom: parent.querySelector('[data-chat-message-id="message-79"]')?.getBoundingClientRect()
      .bottom,
    detached: !!document.querySelector('[aria-label="回到会话底部"]')
  }
}
const record = async (mutate, count = 18) => {
  const samples = [sample()]
  mutate()
  for (let i = 0; i < count; i++) {
    await frames(1)
    samples.push(sample())
  }
  return samples
}
const grow = (lines = 1) => {
  const state = threadStore.getState()
  const messages = state.messages.map((message, i) =>
    i === state.messages.length - 1
      ? { ...message, content: message.content + "Streamed readable body line.\n".repeat(lines) }
      : message
  )
  flushSync(() =>
    threadStore.setState({ messages, messagesContentVersion: state.messagesContentVersion + 1 })
  )
}
window.followingFixture = {
  frames,
  sample,
  record,
  grow,
  threadStore,
  streamStore,
  mount: (id) => flushSync(() => root.render(<ChatContainer key={id} threadId={id} />)),
  unmount: () => flushSync(() => root.render(null))
}
window.followingFixture.mount("following-a")
