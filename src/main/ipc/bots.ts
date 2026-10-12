import { registerDesktopBotLinkPreviews } from "../bots/desktop-link-preview"
import { BrowserWindow, ipcMain } from "electron"
import { z } from "zod"
import { registerBotShellResourceHandlers } from "./bot-shell-resources"
import { botIpcFailure } from "../bots/error-diagnostic"
import type { CoworkBotAPI, BotRpcMethod } from "../../shared/bot-api"
import { getDesktopBotClient, restartDesktopBotHost } from "../bots/desktop-client"
import {
  startDesktopBotArtifactDownload,
  pageDesktopBotArtifactDownloads,
  resumeDesktopBotArtifactDownload,
  pauseDesktopBotArtifactDownload,
  cancelDesktopBotArtifactDownload,
  revealDesktopBotArtifactDownload,
  forgetDesktopBotArtifactDownload
} from "../bots/desktop-artifact-download-service"
import {
  executeDesktopBotBackup,
  listDesktopBotBackups,
  revealDesktopBotBackups
} from "../bots/desktop-backups"
import {
  executeDesktopBotBrowserMaintenance,
  listDesktopBotBrowserCheckpoints
} from "../bots/desktop-browser-maintenance"

import {
  executeDesktopBotWorkspaceMaintenance,
  listDesktopBotWorkspaceCheckpoints,
  revealDesktopBotWorkspaceRecovery
} from "../bots/desktop-workspace-maintenance"
import {
  listDesktopBotComputerCheckpoints,
  listDesktopBotComputerRecoveryCopies,
  desktopBotComputerProgress,
  executeDesktopBotComputerCheckpoint,
  deleteDesktopBotComputerRecoveryCopy,
  revealDesktopBotComputerRecoveryCopy,
  revealDesktopBotComputerDeliverables,
  listDesktopBotComputerDeliverables
} from "../bots/desktop-computer-checkpoints"

const methods = [
  "getErrorTrays",
  "dismissErrorTray",
  "clearErrorTrays",
  "usageBudget",
  "changeUsageBudget",
  "pluginPanes",
  "pluginPaneAction",
  "checkModel",
  "cancelModelCheck",
  "changeNotifications",
  "primaryBot",
  "changePrimaryBot",
  "ensurePrimaryBot",
  "changePrimaryCheckIn",
  "avatar",
  "changeAvatar",
  "thread",
  "threadSummaries",
  "react",
  "reactions",
  "secrets",
  "saveSecret",
  "deleteSecret",
  "provideSecret",
  "filePreview",
  "cancelFilePreview",
  "beginUpload",
  "uploadChunk",
  "finishUpload",
  "cancelUpload",
  "fileChunk",
  "teachHistory",
  "teachVideoChunk",
  "teachDelete",
  "connectors",
  "backupSchedule",
  "changeBackupSchedule",
  "teachRetry",
  "skillTrials",
  "skillDependencies",
  "checkSkillDependencies",
  "trialSkill",
  "reviewSkillTrial",
  "teachStatus",
  "teachStart",
  "teachPause",
  "teachStop",
  "emitEvent",
  "webhook",
  "changeWebhook",
  "restartWebhook",
  "runRoutine",
  "artifacts",
  "deleteFile",
  "upload",
  "download",
  "effects",
  "peerExchange",
  "runHistory",
  "runOutput",
  "notificationEvents",
  "openRuns",
  "pendingInteractions",
  "pendingCard",
  "trackedWork",
  "worktreeDetail",
  "worktreeMerge",
  "worktreeCleanup",
  "workflowControl",
  "effectDetail",
  "interactionDetail",
  "approvalRules",
  "autoReviewSettings",
  "changeAutoReview",
  "changeApprovalRule",
  "recover",
  "status",
  "snapshot",
  "events",
  "create",
  "clone",
  "importThreadContext",
  "setReadState",
  "reorderPinned",
  "update",
  "delete",
  "createGroup",
  "updateGroup",
  "send",
  "messages",
  "search",
  "message",
  "cancel",
  "answer",
  "answerIntroductionQuestion",
  "memoryPolicy",
  "setMemoryPolicy",
  "retryMemory",
  "sharedMemories",
  "saveSharedMemory",
  "skillLibrary",
  "installedSkills",
  "availableSkills",
  "asyncTasks",
  "shellJob",
  "stopShellJob",
  "inspectInstalledSkill",
  "publishSkill",
  "setSkillEnabled",
  "withdrawSkill",
  "deleteSharedMemory",
  "memories",
  "saveMemory",
  "deleteMemory",
  "skills",
  "skillMaintenance",
  "configureSkillMaintenance",
  "changeSkillMaintenance",
  "runSkillMaintenance",
  "saveSkill",
  "deleteSkill",
  "routines",
  "routineHistory",
  "routineDispatchHistory",
  "saveRoutine",
  "deleteRoutine",
  "skillCandidates",
  "referenceCandidates",
  "localToolPermission",
  "changeLocalToolPermission",
  "resolveLocalToolPermission",
  "computerOpen",
  "computerFrame",
  "computerTake",
  "computerRelease",
  "computerInput",
  "nativeComputerOpen",
  "nativeComputerWindows",
  "nativeComputerSelect",
  "nativeComputerObserve",
  "nativeComputerPrepareSecret",
  "nativeComputerProvideSecret",
  "nativeComputerFrame",
  "nativeComputerTake",
  "nativeComputerRelease",
  "nativeComputerInput"
] as const satisfies readonly BotRpcMethod[]

export function registerBotHandlers(): void {
  registerDesktopBotLinkPreviews()
  registerBotShellResourceHandlers()
  const downloads: Record<string, (input: unknown, owner: BrowserWindow) => Promise<unknown>> = {
    start: startDesktopBotArtifactDownload,
    page: pageDesktopBotArtifactDownloads,
    resume: resumeDesktopBotArtifactDownload,
    pause: pauseDesktopBotArtifactDownload,
    cancel: cancelDesktopBotArtifactDownload,
    reveal: revealDesktopBotArtifactDownload,
    forget: forgetDesktopBotArtifactDownload
  }
  for (const [name, handler] of Object.entries(downloads)) {
    ipcMain.handle(`bots:artifact-download:${name}`, async (event, input: unknown) => {
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner || event.senderFrame !== event.sender.mainFrame)
        throw new Error("Bot 请求必须来自应用主界面")
      try {
        return await handler(input, owner)
      } catch (error) {
        return botIpcFailure(error)
      }
    })
  }
  for (const [name, handler] of [
    ["list", () => listDesktopBotComputerCheckpoints()],
    ["deliverables", () => listDesktopBotComputerDeliverables()],
    ["recovery-copies", () => listDesktopBotComputerRecoveryCopies()],
    ["progress", () => desktopBotComputerProgress()],
    ["execute", (input: unknown) => executeDesktopBotComputerCheckpoint(input)],
    ["delete-recovery", (input: unknown) => deleteDesktopBotComputerRecoveryCopy(input)],
    ["reveal-recovery", (input: unknown) => revealDesktopBotComputerRecoveryCopy(input)],
    ["reveal-deliverables", (input: unknown) => revealDesktopBotComputerDeliverables(input)]
  ] as const) {
    ipcMain.handle(`bots:computer-checkpoint:${name}`, async (event, input: unknown) => {
      if (
        !BrowserWindow.fromWebContents(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Bot 请求必须来自应用主界面")
      try {
        return await handler(input)
      } catch (error) {
        return botIpcFailure(error)
      }
    })
  }
  ipcMain.handle("bots:host:restart", async (event, input: unknown) => {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("Bot 请求必须来自应用主界面")
    const { hostId } = z
      .object({ hostId: z.string().min(1).max(128) })
      .strict()
      .parse(input)
    try {
      return await restartDesktopBotHost(hostId)
    } catch (error) {
      return botIpcFailure(error)
    }
  })
  for (const [name, handler] of [
    ["list", () => listDesktopBotWorkspaceCheckpoints()],
    ["execute", (input: unknown) => executeDesktopBotWorkspaceMaintenance(input)],
    ["reveal-recovery", () => revealDesktopBotWorkspaceRecovery()]
  ] as const) {
    ipcMain.handle(`bots:workspace-maintenance:${name}`, async (event, input: unknown) => {
      if (
        !BrowserWindow.fromWebContents(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Bot 请求必须来自应用主界面")
      return handler(input)
    })
  }
  for (const [name, handler] of [
    ["list", () => listDesktopBotBrowserCheckpoints()],
    ["execute", (input: unknown) => executeDesktopBotBrowserMaintenance(input)]
  ] as const) {
    ipcMain.handle(`bots:browser-maintenance:${name}`, async (event, input: unknown) => {
      if (
        !BrowserWindow.fromWebContents(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Bot 请求必须来自应用主界面")
      try {
        return await handler(input)
      } catch (error) {
        return botIpcFailure(error)
      }
    })
  }
  for (const [name, handler] of [
    ["list", () => listDesktopBotBackups()],
    ["execute", (input: unknown) => executeDesktopBotBackup(input)],
    ["reveal", () => revealDesktopBotBackups()]
  ] as const) {
    ipcMain.handle(`bots:backup:${name}`, async (event, input: unknown) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || event.senderFrame !== event.sender.mainFrame)
        throw new Error("Bot 请求必须来自应用主界面")
      return handler(input)
    })
  }
  for (const method of methods) {
    ipcMain.handle(`bots:${method}`, async (event, input: unknown) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || event.senderFrame !== event.sender.mainFrame)
        throw new Error("Bot 请求必须来自应用主界面")
      try {
        const client = await getDesktopBotClient()
        // Transport validates each method's untrusted input before accessing state or resources.
        const call = client.call.bind(client) as (
          name: keyof CoworkBotAPI,
          input?: unknown
        ) => Promise<unknown>
        return await call(method, input)
      } catch (error) {
        // Every named domain method shares the same wire contract. Decode only
        // after contextBridge; both Electron boundaries strip Error.code.
        return botIpcFailure(error)
      }
    })
  }
}
