import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"
import { releaseSubmitInFlightLock, tryAcquireSubmitInFlightLock } from "./submit-in-flight-lock"

/** Exercise the production callback and its shared lock, not a second routing implementation. */
function callback(overrides: object = {}) {
  const file = ts.createSourceFile(
    "ChatContainer.tsx",
    readFileSync(resolve("src/renderer/src/components/chat/ChatContainer.tsx"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let expression: ts.Node | undefined
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "startChatFlow")
      expression = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!expression) throw Error("Production callback missing")
  const scope = {
    readOnly: false,
    historyLoading: false,
    contextReminderPending: false,
    isLoading: false,
    pendingApproval: false,
    approvalQueue: [],
    hasActiveGoalRunning: false,
    threadId: "thread",
    submitInFlightRef: { current: new Set<string>() },
    tryAcquireSubmitInFlightLock,
    releaseSubmitInFlightLock,
    chatFlow: { active: false, submit: vi.fn(async () => true) },
    ...overrides
  }
  const code = ts.transpileModule(`(${expression.getText(file)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return { scope, start: runInNewContext(code, scope) as (goal: string) => Promise<boolean> }
}
it("does not start while ordinary chat owns the preparation lock", async () => {
  const { scope, start } = callback()
  scope.submitInFlightRef.current.add("thread")
  await expect(start("keep this goal")).rejects.toThrow("准备发送消息")
  expect(scope.chatFlow.submit).not.toHaveBeenCalled()
  expect(scope.submitInFlightRef.current.has("thread")).toBe(true)
})
it("owns the same lock through async preflight and releases it on rejection", async () => {
  let reject!: (error: Error) => void
  const submit = vi.fn(
    () =>
      new Promise<boolean>((_resolve, failure) => {
        reject = failure
      })
  )
  const { scope, start } = callback({ chatFlow: { active: false, submit } })
  const pending = start("goal")
  expect(tryAcquireSubmitInFlightLock(scope.submitInFlightRef, true, "thread")).toBe(false)
  reject(Error("stale version"))
  await expect(pending).rejects.toThrow("stale version")
  expect(scope.submitInFlightRef.current.size).toBe(0)
})
it.each([
  "readOnly",
  "historyLoading",
  "contextReminderPending",
  "isLoading",
  "pendingApproval",
  "hasActiveGoalRunning"
])("respects %s without invoking flow runtime", async (field) => {
  const { scope, start } = callback({ [field]: true })
  await expect(start("goal")).rejects.toThrow("未完成")
  expect(scope.chatFlow.submit).not.toHaveBeenCalled()
})
