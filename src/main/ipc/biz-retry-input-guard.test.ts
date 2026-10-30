import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import type {
  AgentRunDelivery,
  AgentRunExecutionContext,
  AgentRunRequest
} from "../agent/agent-run-service"

type RunEntry = (
  request: AgentRunRequest,
  delivery: AgentRunDelivery,
  context: AgentRunExecutionContext
) => Promise<void>

// Execute the production registration callback with transport/storage boundaries stubbed.
// Importing the full Electron agent would start unrelated tool and runtime dependencies.
function loadRunEntry(blocked: boolean) {
  const file = ts.createSourceFile(
    "agent.ts",
    readFileSync(resolve("src/main/ipc/agent.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  let registration: ts.CallExpression | undefined
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === "registerAgentRunImplementation"
    ) {
      registration = node
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!registration) throw new Error("Agent run implementation is not registered")
  const blocksThread = vi.fn(() => blocked)
  const reachedExecution = new Error("ordinary execution reached")
  const getThreadCore = vi.fn(() => {
    throw reachedExecution
  })
  let entry!: RunEntry
  const code = ts.transpileModule(registration.getText(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  new Function(
    "registerAgentRunImplementation",
    "agentRunExecutionContextStorage",
    "managedBizRetryService",
    "resolveAgentStreamRequestChannel",
    "getThreadCore",
    code
  )(
    (implementation: RunEntry) => {
      entry = implementation
    },
    { run: (_context: unknown, execute: () => Promise<void>) => execute() },
    { blocksThread },
    (channel: string, requestId: string) => `${channel}:${requestId}`,
    getThreadCore
  )
  return { entry, blocksThread, getThreadCore, reachedExecution }
}

describe("Agent entry Biz Retry guard wiring", () => {
  it("rejects an ordinary submission before touching execution and reports its terminal result", async () => {
    const { entry, blocksThread, getThreadCore } = loadRunEntry(true)
    const send = vi.fn()
    const onRunTerminated = vi.fn()
    await entry(
      { threadId: "thread", message: "hello", streamRequestId: "request" },
      { send } as unknown as AgentRunDelivery,
      { source: "desktop", onRunTerminated }
    )
    expect(blocksThread).toHaveBeenCalledWith("thread")
    expect(getThreadCore).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledExactlyOnceWith("agent:stream:thread:request", {
      type: "error",
      error: "请在决策入口操作"
    })
    expect(onRunTerminated).toHaveBeenCalledExactlyOnceWith({
      outcome: "error",
      code: "human_decision_pending",
      message: "请在决策入口操作"
    })
  })

  it.each([false, true])(
    "allows execution when managedExecution=%s and the guard permits it",
    async (managedExecution) => {
      const { entry, blocksThread, reachedExecution } = loadRunEntry(managedExecution)
      const send = vi.fn()
      await expect(
        entry(
          { threadId: "thread", message: "hello", managedExecution },
          { send } as unknown as AgentRunDelivery,
          { source: "desktop" }
        )
      ).rejects.toBe(reachedExecution)
      expect(send).not.toHaveBeenCalled()
      expect(blocksThread).toHaveBeenCalledTimes(managedExecution ? 0 : 1)
    }
  )
})
