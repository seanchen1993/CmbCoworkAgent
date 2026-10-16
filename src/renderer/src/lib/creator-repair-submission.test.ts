import { expect, it, vi } from "vitest"
import { enqueueCreatorRepair } from "./creator-repair-submission"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"

function fixture() {
  return {
    text: "读取失败原因并修复天气条",
    modelId: "custom:configured",
    modelAvailable: true,
    blocked: false,
    hasQueuedMessages: false,
    assertCurrent: vi.fn(),
    enqueue: vi.fn(),
    clearError: vi.fn(),
    resumeQueue: vi.fn()
  }
}

it("submits only the repair instruction without consuming composer attachments or draft", () => {
  const f = fixture()
  enqueueCreatorRepair(f)
  expect(f.enqueue).toHaveBeenCalledOnce()
  expect(f.enqueue.mock.calls[0][0]).toMatchObject({
    text: f.text,
    modelId: f.modelId,
    skillBlock: "",
    builtinBrowser: false,
    attachmentModelBlocks: "",
    attachmentDisplayPrefix: ""
  })
  expect(f.clearError).toHaveBeenCalledOnce()
  expect(f.resumeQueue).toHaveBeenCalledOnce()
})

it.each(["blocked", "hasQueuedMessages", "modelAvailable"] as const)(
  "preserves the queue when %s prevents a repair",
  (field) => {
    const f = fixture()
    f[field] = field !== "modelAvailable"
    expect(() => enqueueCreatorRepair(f)).toThrow()
    expect(f.enqueue).not.toHaveBeenCalled()
    expect(f.clearError).not.toHaveBeenCalled()
    expect(f.resumeQueue).not.toHaveBeenCalled()
  }
)

it("rejects a stale chat before creating any new user turn", () => {
  const f = fixture()
  f.assertCurrent.mockImplementation(() => {
    throw Error("scope changed")
  })
  expect(() => enqueueCreatorRepair(f)).toThrow("scope changed")
  expect(f.enqueue).not.toHaveBeenCalled()
})

it("the real repair callback reads new queue and task facts after creator setup awaits", () => {
  const file = ts.createSourceFile(
    "ChatContainer.tsx",
    readFileSync("src/renderer/src/components/chat/ChatContainer.tsx", "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "requestCreatorRepair")
      expression = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(expression).toBeDefined()
  const addQueuedMessage = vi.fn()
  const latest = {
    models: [{ id: "model", available: true }],
    historyLoading: false,
    pendingUserInput: null,
    hasActiveGoalRunning: false,
    bizRetryPending: false,
    flowActive: false,
    flowBusy: false,
    queuedMessages: [] as object[]
  }
  const scope = {
    enqueueCreatorRepair,
    addQueuedMessage,
    threadId: "thread",
    currentForkWorkspacePath: "local",
    clearError: vi.fn(),
    setQueueAutoDrainSuppressed: vi.fn(),
    creatorRepairAdmission: { current: latest },
    submissionStateRef: {
      current: {
        threadId: "thread",
        currentModel: "model",
        readOnly: false,
        isLoading: false,
        contextReminderPending: false,
        pendingApproval: null,
        approvalQueue: []
      }
    },
    submitInFlightRef: { current: new Set() },
    creatorNavigation: { current: { threadId: "thread", readOnly: false } },
    useAppStore: {
      getState: () => ({
        currentThreadId: "thread",
        threads: [{ thread_id: "thread", metadata: {} }]
      })
    },
    getForkWorkspacePath: () => "local",
    normalizeWorkspacePathKey: (value: string) => value,
    isDevelopmentThreadMetadata: () => true
  }
  const code = ts.transpileModule(`(${expression!.getText(file)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const repair = runInNewContext(code, scope) as (text: string) => void
  latest.queuedMessages = [{}]
  expect(() => repair("repair")).toThrow("CREATOR_REPAIR_QUEUE_NOT_EMPTY")
  expect(addQueuedMessage).not.toHaveBeenCalled()
  expect(scope.setQueueAutoDrainSuppressed).not.toHaveBeenCalled()
  latest.queuedMessages = []
  latest.flowActive = true
  expect(() => repair("repair")).toThrow("CREATOR_REPAIR_BUSY")
  expect(addQueuedMessage).not.toHaveBeenCalled()
})
