import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"

// Run the real IPC callbacks without initializing Electron or the agent runtime.
function loadCancelCallback(path: string, channel: string, dependencies: Record<string, unknown>) {
  const file = ts.createSourceFile(
    path,
    readFileSync(resolve(path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  let callback: ts.Expression | undefined
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "handle" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === channel
    ) {
      callback = node.arguments[1]
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!callback) throw new Error(`Missing cancellation callback: ${channel}`)
  const code = ts.transpileModule(`const execute = ${callback.getText(file)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  return new Function(...Object.keys(dependencies), `${code}\nreturn execute`)(
    ...Object.values(dependencies)
  ) as (event: { sender: object }, input: Record<string, unknown>) => Promise<boolean> | boolean
}

function loadWorkerCancel(
  options: { workerCount?: number; foreground?: boolean; foreignOwner?: boolean } = {}
) {
  const worker = { worker_id: "worker" }
  const cancelWorkers = vi.fn(() => Array.from({ length: options.workerCount ?? 1 }, () => worker))
  const abortForeground = vi.fn()
  const cancelManaged = vi.fn()
  const dismissNotifications = vi.fn()
  const execute = loadCancelCallback("src/main/ipc/agent.ts", "agent:cancel", {
    withThreadRunMutationLock: (_threadId: string, run: () => unknown) => run(),
    getLocalThreadRunLease: () => (options.foreignOwner ? { owner: "managed" } : undefined),
    BrowserWindow: { fromWebContents: () => null },
    activeRuns: new Map(options.foreground ? [["thread", { abort: abortForeground }]] : []),
    turnStates: new Map(),
    coordinatorWorkerManager: {
      cancelWorkersForThread: cancelWorkers,
      waitForWorkerCleanup: () => Promise.resolve(),
      acknowledgeNotifications: dismissNotifications
    },
    handleAutoModeAgentCancelled: cancelManaged,
    LocalSandbox: { cancelBackgroundTasks: vi.fn() }
  })
  return { execute, cancelWorkers, abortForeground, cancelManaged, dismissNotifications }
}

describe("managed background cancellation IPC wiring", () => {
  it("forwards an actual worker cancellation and keeps cancelled notifications dismissed", async () => {
    const { execute, cancelWorkers, cancelManaged, dismissNotifications } = loadWorkerCancel()

    await execute({ sender: {} }, { threadId: "thread", cancelWorkers: true })

    expect(cancelWorkers).toHaveBeenCalledExactlyOnceWith(
      "thread",
      "User cancelled coordinator workers.",
      { suppressNotificationAutoRun: true, dismissNotificationOnTerminalPersist: true }
    )
    expect(cancelManaged).toHaveBeenCalledExactlyOnceWith("thread", "background")
    expect(dismissNotifications).toHaveBeenCalledWith("thread", ["worker"])
  })

  it("does not notify the managed controller when no worker was running", async () => {
    const { execute, cancelManaged } = loadWorkerCancel({ workerCount: 0 })

    await execute({ sender: {} }, { threadId: "thread", cancelWorkers: true })

    expect(cancelManaged).not.toHaveBeenCalled()
  })

  it("keeps the foreground agent alive when the user stops workers", async () => {
    const { execute, abortForeground, cancelManaged } = loadWorkerCancel({ foreground: true })

    await execute({ sender: {} }, { threadId: "thread", cancelWorkers: true })

    expect(abortForeground).not.toHaveBeenCalled()
    expect(cancelManaged).toHaveBeenCalledExactlyOnceWith("thread", "background")
  })

  it("preserves foreground cancellation", async () => {
    const { execute, abortForeground, cancelManaged } = loadWorkerCancel({ foreground: true })

    expect(await execute({ sender: {} }, { threadId: "thread" })).toBe(true)

    expect(abortForeground).toHaveBeenCalledOnce()
    expect(cancelManaged).toHaveBeenCalledExactlyOnceWith("thread")
  })

  it("preserves the refusal to cancel a thread owned by another transport", async () => {
    const { execute, cancelWorkers, cancelManaged } = loadWorkerCancel({ foreignOwner: true })

    expect(await execute({ sender: {} }, { threadId: "thread", cancelWorkers: true })).toBe(false)

    expect(cancelWorkers).not.toHaveBeenCalled()
    expect(cancelManaged).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    "forwards workflow cancellation only when cancelled=%s",
    async (cancelled) => {
      const cancelWorkflow = vi.fn(() => cancelled)
      const cancelManaged = vi.fn()
      const execute = loadCancelCallback("src/main/ipc/workflows.ts", "workflow:cancel-run", {
        workflowRunManager: { cancel: cancelWorkflow },
        handleAutoModeAgentCancelled: cancelManaged
      })

      expect(await execute({ sender: {} }, { threadId: "thread", runId: "workflow" })).toBe(
        cancelled
      )

      expect(cancelWorkflow).toHaveBeenCalledExactlyOnceWith("thread", "workflow")
      if (cancelled) expect(cancelManaged).toHaveBeenCalledExactlyOnceWith("thread", "background")
      else expect(cancelManaged).not.toHaveBeenCalled()
    }
  )
})
