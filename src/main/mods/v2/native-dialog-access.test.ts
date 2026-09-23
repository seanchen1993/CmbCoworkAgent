import { afterEach, expect, it, vi } from "vitest"
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: () => {} }
      }
    ]
  }
}))
vi.mock("../../app-attention-events", () => ({ emitAppAttention: () => {} }))
import { nativeFunctionDialogAccess } from "./native-dialog-access"
import { modCallContext, type ModCallContext } from "../context"
import {
  requestUserInput,
  getPendingUserInputForThread,
  acknowledgeUserInputRequest,
  cancelUserInputsForThread,
  submitUserInputResponse
} from "../../services/user-input"

const releases: Array<() => void> = []
afterEach(() => {
  cancelUserInputsForThread("thread", "test cleanup")
  for (const release of releases.splice(0)) release()
})
const questions = [
  {
    id: "choice",
    header: "Plan",
    question: "Choose?",
    options: [
      { label: "One", description: "First" },
      { label: "Two", description: "Second" }
    ]
  }
]
function open(context?: Partial<ModCallContext>) {
  const scope: ModCallContext = {
    identity: {
      callId: "call",
      toolCallId: "tool-call",
      threadId: "thread",
      turnId: "turn",
      agentId: "main",
      workspace: "/workspace",
      origin: "mod",
      modId: "function:owner",
      grantEpoch: 1
    },
    toolId: "host:request_user_input",
    originMod: "function:owner",
    routeClaimed: true,
    readOnly: false,
    protectedOutput: false,
    ...context
  }
  return modCallContext.run(scope, () =>
    requestUserInput({ threadId: "thread", questions }).catch((error) => error)
  )
}
it("binds only acknowledged native dialogs to actual host tool identity and settlement", async () => {
  const access = nativeFunctionDialogAccess("/workspace", "thread")
  const removed = vi.fn()
  releases.push(access.subscribeClosed(removed))
  const result = open()
  const request = getPendingUserInputForThread("thread")!
  expect(access.lookup("tool-call")).toBeUndefined()
  expect(acknowledgeUserInputRequest(request.requestId, "wrong-thread")).toBe(false)
  expect(acknowledgeUserInputRequest(request.requestId, "thread")).toBe(true)
  expect(access.lookup("tool-call")).toEqual({
    toolUseId: "tool-call",
    requestId: request.requestId,
    owner: "function:owner"
  })
  expect(access.lookup("other")).toBeUndefined()
  submitUserInputResponse({
    requestId: request.requestId,
    answers: {},
    submittedAt: new Date().toISOString(),
    ignored: true
  })
  await result
  expect(removed).toHaveBeenCalledWith(request.requestId)
  expect(access.lookup("tool-call")).toBeUndefined()
})
it("refuses cross-workspace, late cancelled contexts and disposed listeners", async () => {
  const other = nativeFunctionDialogAccess("/other", "thread")
  const own = nativeFunctionDialogAccess("/workspace", "thread")
  releases.push(other.subscribeClosed(() => {}))
  const release = own.subscribeClosed(() => {})
  releases.push(release)
  const controller = new AbortController()
  const result = open({ signal: controller.signal })
  const request = getPendingUserInputForThread("thread")!
  acknowledgeUserInputRequest(request.requestId, "thread")
  expect(other.lookup("tool-call")).toBeUndefined()
  expect(own.lookup("tool-call")).toBeDefined()
  controller.abort()
  expect(own.lookup("tool-call")).toBeUndefined()
  release()
  expect(own.lookup("tool-call")).toBeUndefined()
  cancelUserInputsForThread("thread", "cancel")
  await result
})

it("uses the same host call ID fallback as SDK tool.call when no model tool ID exists", async () => {
  const access = nativeFunctionDialogAccess("/workspace", "thread")
  releases.push(access.subscribeClosed(() => {}))
  const result = open({
    identity: {
      callId: "sdk-call",
      threadId: "thread",
      turnId: "turn",
      agentId: "main",
      workspace: "/workspace",
      origin: "mod",
      modId: "function:owner",
      grantEpoch: 1
    }
  })
  const request = getPendingUserInputForThread("thread")!
  acknowledgeUserInputRequest(request.requestId, "thread")
  expect(access.lookup("sdk-call")).toEqual({
    toolUseId: "sdk-call",
    requestId: request.requestId,
    owner: "function:owner"
  })
  cancelUserInputsForThread("thread", "cleanup")
  await result
})
