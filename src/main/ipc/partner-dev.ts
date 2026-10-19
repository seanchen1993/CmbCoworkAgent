import {
  app,
  BrowserWindow,
  dialog,
  safeStorage,
  type IpcMain,
  type IpcMainInvokeEvent
} from "electron"
import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, join, normalize } from "node:path"
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
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { serviceConversationInput } from "../services/bot/service-conversation-boundary"
import {
  ServiceConversationStore,
  serviceScopeKey,
  type ServiceScope
} from "../services/bot/service-conversation-store"
import { ServiceConversationService } from "../services/bot/service-conversation"
import { ServiceConversationRouter } from "../services/bot/service-conversation-router"
import {
  resolveServiceModel,
  serviceModelBinding,
  type ServiceModelBinding
} from "../services/bot/service-model-binding"
import { expertLocalData } from "../services/bot/expert-local-data"

let controller: PartnerDevController | undefined
let conversations: ServiceConversationService | undefined
export function hasActivePartnerDevRun(): boolean {
  return controller?.hasActiveRun() ?? false
}
export async function stopPartnerDev(): Promise<void> {
  await conversations?.stop()
  await controller?.shutdown()
}

export function registerPartnerDevHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
  rendererUrl: string | undefined
): void {
  // Set only by the isolated local preview launcher. No production auto-login,
  // renderer-selected path, hardcoded bearer or plaintext credential fallback.
  const defaultConnectionFile = app.isPackaged
    ? undefined
    : process.env.CMB_PARTNER_LOCAL_CONNECTION_FILE
  let journal: ServiceConversationStore | undefined
  let router: ServiceConversationRouter | undefined
  const getJournal = () => (journal ??= new ServiceConversationStore(getDb()))
  const scopeFor = (
    config: import("../services/bot/partner-local-config").PartnerLocalConfig
  ): ServiceScope => {
    const d = config.descriptor
    if (!config.groupId || !config.botId) throw new PartnerLocalFault("NOT_CONFIGURED")
    return {
      url: d.url,
      spaceId: d.spaceId,
      nodeId: d.nodeId,
      ownerPrincipalId: d.ownerPrincipalId,
      businessPrincipalId: d.businessPrincipalId,
      workspaceRef: d.workspaceRef,
      workspaceHash: createHash("sha256")
        .update(config.workspacePath ?? "")
        .digest("hex"),
      groupId: config.groupId,
      botId: config.botId
    }
  }
  const getConversations = () =>
    (conversations ??= new ServiceConversationService({
      store: getJournal(),
      context: () => controller!.conversationContext(),
      overview: async () => {
        const s = await controller!.getStatus()
        return {
          connected: s.connected,
          nodeEnabled: s.nodeEnabled,
          expertName: s.expertName ?? null
        }
      },
      model: resolveServiceModel,
      models: async () => {
        const { getModelConfigs } = await import("../models/registry")
        return getModelConfigs().flatMap((c) => {
          try {
            const b = serviceModelBinding(c, c.ref)
            return [{ ref: b.ref, name: b.name }]
          } catch {
            return []
          }
        })
      },
      cancelOwned: (runId) => router?.cancelOwned(runId) ?? false
    }))
  conversations = undefined
  controller = new PartnerDevController({
    onWorkerChange: () => conversations?.wake(),
    async beforeLegacyEnqueue(config, client, task, commandId, deadline) {
      const scope = scopeFor(config),
        group = await client.getBusinessGroup(scope.groupId),
        bot = group.bots.find((b) => b.botId === scope.botId)
      if (!bot) throw new PartnerLocalFault("FORBIDDEN")
      getJournal().bind(serviceScopeKey(scope), {
        ...scope,
        commandId,
        taskId: task.id,
        taskVersion: task.version,
        stageId: task.currentStageId,
        groupVersion: group.version,
        botVersionId: bot.botVersionId,
        deadline,
        model: { ref: PARTNER_FAKE_MODEL_REF, name: "模拟模型", hash: "" },
        kind: "legacy",
        runId: null,
        attemptId: null
      })
    },
    store: new PartnerLocalConfigStore(
      join(app.getPath("userData"), "devclaw-partner-local"),
      safeStorage
    ),
    expertData: (descriptor, botId) =>
      expertLocalData(
        getCmbCoworkAgentDataRoot(),
        defaultConnectionFile ?? descriptor.url,
        descriptor,
        botId
      ),
    ...(defaultConnectionFile
      ? {
          defaultDescriptor: async () => {
            if (
              !isAbsolute(defaultConnectionFile) ||
              normalize(defaultConnectionFile) !== defaultConnectionFile
            )
              throw new PartnerLocalFault("STORAGE_FAILURE")
            return readPartnerPrivateJson(defaultConnectionFile)
          }
        }
      : {}),
    createExecutor(config, client) {
      const db = getDb(),
        d = config.descriptor
      const createExecutor = (
        model?: ServiceModelBinding,
        refusalCode?: "MODEL_CHANGED" | "MODEL_UNAVAILABLE"
      ) =>
        new PartnerRequirementExecutor({
          config: {
            spaceId: d.spaceId,
            nodeId: d.nodeId,
            ownerPrincipalId: d.ownerPrincipalId,
            modelRef: model?.ref ?? PARTNER_FAKE_MODEL_REF,
            ...(model ? { modelConfigHash: model.hash } : {}),
            workspaces: new Map([[d.workspaceRef, config.workspacePath!]])
          },
          control: client,
          threads: new PartnerTaskThreadStore(db),
          attempts: new PartnerRequirementAttemptStore(db),
          delivery: createManagedTransportAgentRunDelivery(),
          refusalCode,
          cancelBeforeStart: (run) => getConversations().cancelledBeforeStart(scopeFor(config), run)
        })
      router = new ServiceConversationRouter({
        scope: scopeFor(config),
        store: getJournal(),
        legacy: createExecutor(),
        legacyRunId: config.lastRunId,
        model: resolveServiceModel,
        createExecutor: (model, refusal) => createExecutor(model, refusal),
        attemptState: (run) => new PartnerRequirementAttemptStore(db).get(run)?.state ?? null,
        unknown: (scope, run) => getConversations().markUnknown(scope, run),
        refused: (scope, run, code) => getConversations().markRefused(scope, run, code),
        claimed: (scope, run) => getConversations().claimed(scope, run),
        finished: () => conversations?.wake()
      })
      return router
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
  let contextMutations = 0
  const invalidate = (busy: boolean) => {
    const target = getWindow()
    if (target && !target.isDestroyed())
      target.webContents.send("serviceConversation:invalidated", busy)
  }
  const register = (
    operation: string,
    action: (event: IpcMainInvokeEvent, args: unknown[]) => Promise<unknown>
  ): void => {
    ipcMain.handle("partnerDev:" + operation, async (event, ...args: unknown[]) => {
      try {
        trusted(event)
        const changesContext = [
          "connect",
          "disconnect",
          "importConnection",
          "chooseWorkspace",
          "createExpert",
          "revokeLocalAuthorization"
        ].includes(operation)
        if (changesContext) {
          contextMutations++
          invalidate(true)
        }
        try {
          return await action(event, args)
        } finally {
          if (changesContext) {
            contextMutations--
            invalidate(contextMutations > 0)
          }
        }
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
    stopNode: () => current.stopNode(),
    revokeLocalAuthorization: () => current.revokeTeam(),
    startExpert: () => current.startExpert(),
    listExpertMemories: () => current.listExpertMemories()
  }))
    register(name, async (_event, args) => {
      none(args)
      return action()
    })
  for (const operation of [
    "open",
    "selectModel",
    "tasks",
    "read",
    "updates",
    "send",
    "cancel"
  ] as const) {
    ipcMain.handle("serviceConversation:" + operation, async (event, ...args: unknown[]) => {
      try {
        trusted(event)
        if (operation === "open") {
          none(args)
          return await getConversations().open()
        }
        if (args.length !== 1) throw new PartnerLocalFault("INVALID_PAYLOAD")
        const input = serviceConversationInput(operation, args[0])
        return await getConversations()[operation](input)
      } catch (error) {
        throw new Error(error instanceof PartnerLocalFault ? error.code : "DEPENDENCY_UNAVAILABLE")
      }
    })
  }
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
  register("createExpert", async (_event, args) => {
    const v = input(args, ["name", "instructions"])
    return current.createExpert(v.name as string, v.instructions as string)
  })
  register("createExpertMemory", async (_event, args) => {
    const v = input(args, ["text"])
    return current.createExpertMemory(v.text as string)
  })
  register("updateExpertMemory", async (_event, args) => {
    const v = input(args, ["memoryId", "expectedVersion", "text", "status"])
    return current.updateExpertMemory(
      v as unknown as Parameters<PartnerDevController["updateExpertMemory"]>[0]
    )
  })
  register("disableExpertMemory", async (_event, args) => {
    const v = input(args, ["memoryId", "expectedVersion"])
    return current.disableExpertMemory(v.memoryId as string, v.expectedVersion as number)
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
