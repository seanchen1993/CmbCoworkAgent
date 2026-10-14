import { dialog, type IpcMain, type IpcMainInvokeEvent, type WebContents } from "electron"
import type { FlowManager } from "../mods/flows/manager"
import { randomUUID } from "node:crypto"
import { types } from "node:util"

const text = (value: unknown, digest = false): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 200 ||
    value.includes("\0") ||
    (digest && !/^[0-9a-f]{64}$/.test(value))
  )
    throw Error("FLOW_FILE_INPUT_INVALID")
  return value
}
export function registerFlowFilePublicationHandlers(
  ipc: IpcMain,
  flows: FlowManager,
  access: {
    trusted(event: IpcMainInvokeEvent): void
    threadScope(threadId: string): string
    captureThreadFence(threadId: string): () => void
  }
) {
  const owners = new Map<
    string,
    { sender: WebContents; threadId: string; controller: AbortController; done: Promise<void> }
  >()
  const run = async (
    event: IpcMainInvokeEvent,
    threadId: string,
    requestId: string,
    action: (workspace: string, signal: AbortSignal, guard: () => void) => Promise<unknown>
  ) => {
    access.trusted(event)
    const workspace = access.threadScope(threadId),
      sender = event.sender,
      frame = event.senderFrame
    const assertThread = access.captureThreadFence(threadId)
    if (owners.size >= 16 || owners.has(requestId)) throw Error("FLOW_FILE_PUBLICATION_BUSY")
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
    const guard = () => {
      signal.throwIfAborted()
      access.trusted(event)
      assertThread()
      if (
        sender.isDestroyed() ||
        sender.mainFrame !== frame ||
        access.threadScope(threadId) !== workspace
      )
        throw Error("FLOW_FILE_SCOPE_CHANGED")
      signal.throwIfAborted()
    }
    guard()
    const abort = () => controller.abort()
    const navigate = (details: { isMainFrame: boolean }) => {
      if (details.isMainFrame) abort()
    }
    sender.once("destroyed", abort)
    sender.on("did-start-navigation", navigate)
    const watchdog = setInterval(() => {
      try {
        guard()
      } catch {
        abort()
      }
    }, 250)
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    owners.set(requestId, { sender, threadId, controller, done })
    try {
      const result = await action(workspace, signal, guard)
      guard()
      return result
    } finally {
      clearInterval(watchdog)
      sender.removeListener("destroyed", abort)
      sender.removeListener("did-start-navigation", navigate)
      owners.delete(requestId)
      finish()
    }
  }
  const handler = (
    name: string,
    action: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
  ) =>
    ipc.handle(name, async (event, ...args) => {
      try {
        return await action(event, ...args)
      } catch (error) {
        const code = error instanceof Error ? error.message : ""
        throw Error(
          /^(FLOW_FILE|VIRTUAL_PUBLICATION)_[A-Z_]+$/.test(code)
            ? code
            : "FLOW_FILE_PUBLICATION_FAILED"
        )
      }
    })
  handler("mods:flow-file-review", async (event, threadInput, runInput) => {
    const threadId = text(threadInput),
      runId = text(runInput)
    return run(event, threadId, randomUUID(), (workspace, signal, guard) =>
      flows.filePublication(
        workspace,
        threadId,
        runId,
        { kind: "review" },
        undefined,
        signal,
        guard
      )
    )
  })
  handler("mods:flow-file-publish", async (event, input) => {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      types.isProxy(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      throw Error("FLOW_FILE_INPUT_INVALID")
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const keys = ["threadId", "runId", "runDigest", "reviewDigest", "requestId", "kind"]
    if (
      Reflect.ownKeys(input).length !== keys.length ||
      keys.some(
        (key) => !descriptors[key] || !("value" in descriptors[key]) || !descriptors[key].enumerable
      )
    )
      throw Error("FLOW_FILE_INPUT_INVALID")
    const row = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]))
    const threadId = text(row.threadId),
      runId = text(row.runId),
      requestId = text(row.requestId)
    const runDigest = text(row.runDigest, true),
      reviewDigest = text(row.reviewDigest, true)
    const kind = row.kind
    if (kind !== "export" && kind !== "publish") throw Error("FLOW_FILE_INPUT_INVALID")
    return run(event, threadId, requestId, async (workspace, signal, guard) => {
      let destination: string | undefined
      if (kind === "export") {
        const selected = await dialog.showSaveDialog({
          title: "导出已审阅的虚拟文件补丁",
          defaultPath: "flow-changes.json",
          filters: [{ name: "Flow 变更补丁", extensions: ["json"] }]
        })
        guard()
        if (selected.canceled || !selected.filePath) return null
        destination = selected.filePath
      }
      return flows.filePublication(
        workspace,
        threadId,
        runId,
        kind === "export"
          ? { kind, reviewDigest, destination: destination! }
          : { kind, reviewDigest },
        runDigest,
        signal,
        guard
      )
    })
  })
  handler("mods:flow-file-cancel", async (event, threadInput, requestInput) => {
    access.trusted(event)
    const threadId = text(threadInput),
      requestId = text(requestInput)
    const owner = owners.get(requestId)
    if (!owner || owner.sender !== event.sender || owner.threadId !== threadId) return
    owner.controller.abort()
    await owner.done
  })
}
