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
  assert(agent.includes("rejectDesktopRunForRemoteReadOnlyThread"))
  assert(agent.includes("REMOTE_INBOX_DESKTOP_READ_ONLY"))
  assert(agent.includes('metadata.remoteState === "historical"'))
  assert.equal(
    agent.match(/rejectDesktopRunForRemoteReadOnlyThread/g)?.length,
    4,
    "invoke, resume and interrupt must all enforce the remote read-only boundary"
  )
}

function testRemoteThreadsHaveStableSourceAndModeLabels(): void {
  const chat = source("src/renderer/src/components/chat/ChatContainer.tsx")
  const sidebar = source("src/renderer/src/components/sidebar/ThreadSidebar.tsx")
  const robotPanel = source("src/renderer/src/components/customize/BuiltinRobotPanel.tsx")
  assert(chat.includes('remoteThreadInfo.kind === "inbox" ? "远程收件箱" : "远程 Feature"'))
  assert(chat.includes("桌面发出的本轮结果只保留在本机，不会自动发送到招乎"))
  assert(chat.includes("等待桌面审批"))
  assert(chat.includes("执行结果未知"))
  assert(sidebar.includes("getRemoteThreadKind"))
  assert(sidebar.includes("remoteThreadHistorical"))
  assert(sidebar.includes('"远程收件箱"'))
  assert(sidebar.includes('"远程 Feature"'))
  assert(sidebar.includes('"远程历史"'))
  assert(robotPanel.includes("同一用户只保留一个活动桌面连接"))
  assert(robotPanel.includes('? "已登录"'))
  assert(robotPanel.includes(': "未登录"'))
  assert(!robotPanel.includes("企业账号"))
  assert(robotPanel.includes("联调信息"))
  assert(robotPanel.includes("复制联调信息"))
  assert(robotPanel.includes("status.diagnostics.gatewayUrl"))
  assert(robotPanel.includes("网关地址（联调）"))
  assert(robotPanel.includes("保存并重连"))
  assert(robotPanel.includes("gatewayUrl: gatewayUrlDraft.trim()"))
  assert(robotPanel.includes("gatewayUrl: null"))
  assert(!robotPanel.includes("deviceEpoch"))
  assert(!robotPanel.includes("设备版本"))
}

testRemoteInboxIsReadOnlyAtRendererAndMainBoundary()
console.log("PASS testRemoteInboxIsReadOnlyAtRendererAndMainBoundary")
testRemoteThreadsHaveStableSourceAndModeLabels()
console.log("PASS testRemoteThreadsHaveStableSourceAndModeLabels")
console.log("im-remote-thread-ui.spec.ts passed")
