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
  const workspacePicker = source("src/renderer/src/components/chat/WorkspacePicker.tsx")
  const rightPanel = source("src/renderer/src/components/panels/RightPanel.tsx")
  const remoteDisplay = source("src/renderer/src/lib/remote-thread-display.ts")
  const robotPanel = source("src/renderer/src/components/customize/BuiltinRobotPanel.tsx")
  const robotManager = source("src/main/services/im/manager.ts")
  const remoteAccessSwitcher = source(
    "src/renderer/src/components/chat/ThreadRemoteAccessSwitcher.tsx"
  )
  const remoteAccessEligibility = source("src/renderer/src/lib/builtin-robot-remote-access.ts")
  const harnessBoard = source("src/renderer/src/components/harness-board/HarnessBoardView.tsx")
  assert(chat.includes('remoteThreadInfo.kind === "inbox" ? "远程收件箱" : "远程 Feature"'))
  assert(chat.includes("桌面发出的本轮结果只保留在本机，不会自动发送到招乎"))
  assert(chat.includes("等待桌面审批"))
  assert(chat.includes("执行结果未知"))
  assert(sidebar.includes("getRemoteThreadKind"))
  assert(sidebar.includes("remoteThreadHistorical"))
  assert(sidebar.includes('"远程收件箱"'))
  assert(sidebar.includes('"远程 Feature"'))
  assert(sidebar.includes('"远程历史"'))
  assert(remoteDisplay.includes('REMOTE_INBOX_WORKSPACE_NAME = "远程收件箱"'))
  assert(sidebar.includes("isManagedInbox"))
  assert(sidebar.includes("isManagedInbox ? REMOTE_INBOX_WORKSPACE_NAME"))
  assert(sidebar.includes("应用托管目录，路径已隐藏"))
  assert(sidebar.includes("远程收件箱名称由应用管理"))
  assert(workspacePicker.includes("concealWorkspacePath"))
  assert(workspacePicker.includes("应用托管目录，路径已隐藏"))
  assert(rightPanel.includes("concealWorkspacePath"))
  assert(rightPanel.includes("REMOTE_INBOX_WORKSPACE_NAME"))
  assert(robotPanel.includes("同一用户只保留一个活动桌面连接"))
  assert(robotPanel.includes('? "已登录"'))
  assert(robotPanel.includes(': "未登录"'))
  assert(!robotPanel.includes("企业账号"))
  assert(robotPanel.includes("联调信息"))
  assert(robotPanel.includes("复制联调信息"))
  assert(robotPanel.includes("VITE_BUILTIN_ROBOT_DEBUG_YST_IDS"))
  assert(robotPanel.includes("window.api.models.getUserInfo()"))
  assert(robotPanel.includes("BUILTIN_ROBOT_DEBUG_YST_IDS.has(ystId)"))
  assert(robotPanel.includes("canViewDebugInfo &&"))
  assert(robotPanel.includes("status.diagnostics.gatewayUrl"))
  assert(robotPanel.includes("网关地址（联调）"))
  assert(robotPanel.includes("保存并重连"))
  assert(robotPanel.includes("gatewayUrl: gatewayUrlDraft.trim()"))
  assert(robotPanel.includes("gatewayUrl: null"))
  assert(!robotPanel.includes("deviceEpoch"))
  assert(!robotPanel.includes("设备版本"))
  assert(chat.includes("ThreadRemoteAccessSwitcher"))
  assert(chat.includes('setShowCustomizeView(true, "robot")'))
  assert(remoteAccessSwitcher.includes("当前会话接入招乎"))
  assert(remoteAccessSwitcher.includes("window.api.builtinRobot.getRemoteAccess()"))
  assert(remoteAccessSwitcher.includes("window.api.builtinRobot.setThreadRemoteAccess"))
  assert(remoteAccessSwitcher.includes("这一条会话会出现在招乎的 /会话 列表中"))
  assert(!remoteAccessEligibility.includes("isHarnessProjectModeThread"))
  assert(remoteAccessEligibility.includes('metadata.targetKind === "feature"'))
  assert(remoteAccessEligibility.includes('metadata.targetKind !== "inbox"'))
  assert(robotPanel.includes("isBuiltinRobotThreadRemoteAccessEligible"))
  assert(robotPanel.includes("普通会话和 Project Mode 会话均支持"))
  assert(robotPanel.includes("Feature 开关只控制能否从招乎"))
  assert(robotPanel.includes("Feature 远程新建会话"))
  assert(robotPanel.includes("!remoteAccess?.principalAvailable"))
  const featureSetter = robotManager.slice(
    robotManager.indexOf("setFeatureRemoteAccess("),
    robotManager.indexOf("listGrantableFeatures()")
  )
  assert(featureSetter.includes("requireGrantPrincipal()"))
  assert(!featureSetter.includes("requireGrantRoute()"))
  assert(harnessBoard.includes("Feature 远程新建会话"))
  assert(harnessBoard.includes("window.api.builtinRobot.setFeatureRemoteAccess"))
  assert(harnessBoard.includes("const principalAvailable = remoteAccess?.principalAvailable"))
  assert(harnessBoard.includes("关闭后，下方已经接入的会话仍由各自的会话开关管理"))
}

testRemoteInboxIsReadOnlyAtRendererAndMainBoundary()
console.log("PASS testRemoteInboxIsReadOnlyAtRendererAndMainBoundary")
testRemoteThreadsHaveStableSourceAndModeLabels()
console.log("PASS testRemoteThreadsHaveStableSourceAndModeLabels")
console.log("im-remote-thread-ui.spec.ts passed")
