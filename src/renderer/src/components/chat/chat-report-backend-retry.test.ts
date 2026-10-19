import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackendNotConfiguredError, isBackendNotConfiguredError } from "../../api/backend-endpoint"

// Run the original controller callback, including reservation/finally/timer behavior.
function createUpload(error: Error) {
  const source = ts.createSourceFile("ChatContainer.tsx", readFileSync(resolve(
    "src/renderer/src/components/chat/ChatContainer.tsx"
  ), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let callback: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "uploadLoChatDataForThread" &&
      node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!callback) throw new Error("Original upload callback is missing")
  const refs = () => ({ current: {} })
  const uploadChatData = vi.fn().mockRejectedValue(error)
  const failed = vi.fn(), succeeded = vi.fn()
  const dependencies = {
    uploadChatData,
    reserveChatReportMessageIds: vi.fn().mockReturnValue(["message"]),
    markChatReportUploadFailed: failed,
    markChatReportUploadSucceeded: succeeded,
    chatReportDisposedRef: { current: false },
    chatReportAbortControllersRef: refs(), chatReportPendingBatchesRef: refs(),
    chatReportRetryBatchesRef: refs(), chatReportRetryTimersRef: refs(),
    CHAT_REPORT_MAX_RETRY_ATTEMPTS: 3, CHAT_REPORT_RETRY_DELAY_MS: 1000,
    isBackendNotConfiguredError,
    window: { setTimeout, clearTimeout }
  }
  const javascript = ts.transpileModule(
    "const uploadLoChatDataForThread = " + callback.getText(source) + "; return uploadLoChatDataForThread",
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const invoke = new Function(...Object.keys(dependencies), javascript)(...Object.values(dependencies)) as
    (thread: string, batch: { messageIds: string[]; payload: unknown[] }) => Promise<void>
  return { invoke, uploadChatData, failed, succeeded }
}

afterEach(() => vi.useRealTimers())
describe("original chat report retry policy", () => {
  it("keeps failed accounting but schedules no retry for an unconfigured backend", async () => {
    vi.useFakeTimers()
    const run = createUpload(new BackendNotConfiguredError("上报服务"))
    await run.invoke("thread", { messageIds: ["message"], payload: [] })
    expect(run.failed).toHaveBeenCalledWith("thread", ["message"])
    expect(run.succeeded).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(run.uploadChatData).toHaveBeenCalledTimes(1)
  })

  it("preserves all three original bounded retries for real network failure", async () => {
    vi.useFakeTimers()
    const run = createUpload(new TypeError("Failed to fetch"))
    await run.invoke("thread", { messageIds: ["message"], payload: [] })
    expect(vi.getTimerCount()).toBe(1)
    await vi.runAllTimersAsync()
    expect(run.uploadChatData).toHaveBeenCalledTimes(4)
    expect(run.failed).toHaveBeenCalledTimes(4)
    expect(run.succeeded).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
