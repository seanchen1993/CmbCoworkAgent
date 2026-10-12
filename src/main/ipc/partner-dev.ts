import {
  app,
  BrowserWindow,
  dialog,
  safeStorage,
  type IpcMain,
  type IpcMainInvokeEvent
} from "electron"
import { realpath, stat } from "node:fs/promises"
import { join } from "node:path"
import type { PartnerDevStatus } from "../../shared/bot/partner-dev"
import { getDb } from "../db"
import { isTrustedRendererUrl } from "../main-log-forwarding"
import { createManagedTransportAgentRunDelivery } from "../agent/managed-transport-delivery"
import { PartnerDevController } from "../services/bot/partner-dev-controller"
import {
  PartnerLocalConfigStore,
  readPartnerPrivateJson
} from "../services/bot/partner-local-config"
import { PartnerLocalFault, partnerObject } from "../services/bot/partner-local-client"
import { PartnerRequirementExecutor } from "../services/bot/requirement-executor"
import { PartnerTaskThreadStore } from "../services/bot/task-thread-store"
import { PartnerRequirementAttemptStore } from "../services/bot/requirement-attempt-store"
import { PARTNER_FAKE_MODEL_REF } from "../services/bot/partner-fake-model"

let controller: PartnerDevController | undefined
export function hasActivePartnerDevRun(): boolean {
  return controller?.hasActiveRun() ?? false
}
export async function stopPartnerDev(): Promise<void> {
  await controller?.shutdown()
}

export function registerPartnerDevHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
  rendererUrl: string | undefined
): void {
  controller = new PartnerDevController({
    store: new PartnerLocalConfigStore(
      join(app.getPath("userData"), "devclaw-partner-local"),
      safeStorage
    ),
    createExecutor(config, client) {
      const db = getDb(),
        d = config.descriptor
      return new PartnerRequirementExecutor({
        config: {
          spaceId: d.spaceId,
          nodeId: d.nodeId,
          ownerPrincipalId: d.ownerPrincipalId,
          modelRef: PARTNER_FAKE_MODEL_REF,
          workspaces: new Map([[d.workspaceRef, config.workspacePath!]])
        },
        control: client,
        threads: new PartnerTaskThreadStore(db),
        attempts: new PartnerRequirementAttemptStore(db),
        delivery: createManagedTransportAgentRunDelivery()
      })
    }
  })
  const current = controller
  const trusted = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = getWindow(),
      frame = event.senderFrame
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents !== event.sender ||
      !frame ||
      frame !== event.sender.mainFrame ||
      frame.parent !== null
    )
      throw new PartnerLocalFault("FORBIDDEN")
    if (
      !isTrustedRendererUrl(frame.url, rendererUrl) ||
      !isTrustedRendererUrl(event.sender.getURL(), rendererUrl)
    )
      throw new PartnerLocalFault("FORBIDDEN")
    return window
  }
  const register = (
    operation: string,
    action: (event: IpcMainInvokeEvent, args: unknown[]) => Promise<unknown>
  ): void => {
    ipcMain.handle("partnerDev:" + operation, async (event, ...args: unknown[]) => {
      try {
        trusted(event)
        return await action(event, args)
      } catch (error) {
        throw new Error(error instanceof PartnerLocalFault ? error.code : "DEPENDENCY_UNAVAILABLE")
      }
    })
  }
  const none = (args: unknown[]) => {
    if (args.length) throw new PartnerLocalFault("INVALID_PAYLOAD")
  }
  const input = (args: unknown[], keys: string[]) => {
    if (args.length !== 1) throw new PartnerLocalFault("INVALID_PAYLOAD")
    return partnerObject(args[0], keys)
  }
  for (const [name, action] of Object.entries({
    getStatus: () => current.getStatus(),
    connect: () => current.connect(),
    disconnect: () => current.disconnect(),
    enableNode: () => current.enableNode(),
    stopNode: () => current.stopNode(),
    authorizeTeam: () => current.authorizeTeam(),
    revokeTeam: () => current.revokeTeam()
  }))
    register(name, async (_event, args) => {
      none(args)
      return action()
    })
  register("importConnection", async (event, args): Promise<PartnerDevStatus> => {
    none(args)
    const result = await dialog.showOpenDialog(trusted(event), {
      title: "导入 DevClaw 伙伴本地连接文件",
      properties: ["openFile"],
      filters: [{ name: "本地连接 JSON", extensions: ["json"] }]
    })
    if (result.canceled || result.filePaths.length !== 1) return current.getStatus()
    return current.importDescriptor(await readPartnerPrivateJson(result.filePaths[0]))
  })
  register("chooseWorkspace", async (event, args): Promise<PartnerDevStatus> => {
    none(args)
    const result = await dialog.showOpenDialog(trusted(event), {
      title: "负责人明确授权本地工作区（当前不读取文件）",
      properties: ["openDirectory"]
    })
    if (result.canceled || result.filePaths.length !== 1) return current.getStatus()
    const path = await realpath(result.filePaths[0])
    if (!(await stat(path)).isDirectory()) throw new PartnerLocalFault("INVALID_PAYLOAD")
    return current.setWorkspace(path)
  })
  register("createTeam", async (_event, args) => {
    const v = input(args, ["name", "instructions"])
    return current.createTeam(v.name as string, v.instructions as string)
  })
  register("bindTeam", async (_event, args) => {
    const v = input(args, ["groupId"])
    return current.bindTeam(v.groupId as string)
  })
  register("sendMessage", async (_event, args) => {
    const v = input(args, ["mentioned", "text"])
    return current.sendMessage(v.mentioned as boolean, v.text as string)
  })
  register("analyzeTask", async (_event, args) => {
    const v = input(args, ["taskNumber"])
    return current.analyzeTask(v.taskNumber as string)
  })
  register("inspectRun", async (_event, args) => {
    const v = input(args, ["runId"])
    return current.inspectRun(v.runId as string)
  })
  register("cancelPending", async (_event, args) => {
    const v = input(args, ["runId", "expectedVersion"])
    return current.cancelPending(v.runId as string, v.expectedVersion as number)
  })
}
