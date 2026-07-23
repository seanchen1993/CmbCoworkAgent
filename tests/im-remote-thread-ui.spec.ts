import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

function testRemoteInboxIsReadOnlyAtRendererAndMainBoundary(): void {
  const chat = source("src/renderer/src/components/chat/ChatContainer.tsx")
  const agent = source("src/main/ipc/agent.ts")
  assert(chat.includes('remoteThreadInfo?.kind === "inbox"'))
  assert(chat.includes("远程收件箱在桌面仅可查看"))
  assert(
    chat.includes(
      "const effectiveInputDisabled = inputDisabled || contextReminderPending || readOnly"
    )
  )
  assert(agent.includes("rejectDesktopRunForRemoteReadOnlyInbox"))
  assert(agent.includes("REMOTE_INBOX_DESKTOP_READ_ONLY"))
}

function testRemoteThreadsHaveStableSourceAndModeLabels(): void {
  const chat = source("src/renderer/src/components/chat/ChatContainer.tsx")
  const sidebar = source("src/renderer/src/components/sidebar/ThreadSidebar.tsx")
  assert(chat.includes('remoteThreadInfo.kind === "inbox" ? "远程收件箱" : "远程 Feature"'))
  assert(chat.includes("桌面发出的本轮结果只保留在本机，不会自动发送到招乎"))
  assert(chat.includes("等待桌面审批"))
  assert(chat.includes("执行结果未知"))
  assert(sidebar.includes("getRemoteThreadKind"))
  assert(sidebar.includes('remoteThreadKind === "inbox" ? "远程收件箱" : "远程 Feature"'))
}

testRemoteInboxIsReadOnlyAtRendererAndMainBoundary()
console.log("PASS testRemoteInboxIsReadOnlyAtRendererAndMainBoundary")
testRemoteThreadsHaveStableSourceAndModeLabels()
console.log("PASS testRemoteThreadsHaveStableSourceAndModeLabels")
console.log("im-remote-thread-ui.spec.ts passed")
