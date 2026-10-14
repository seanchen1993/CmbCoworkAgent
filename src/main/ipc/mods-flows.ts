import { registerFlowFilePublicationHandlers } from "./mods-flow-files"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { join } from "node:path"
import { getThreadCore } from "../db"
import { isOrdinaryFlowMetadata } from "../../shared/mods/flows/scope"
import { projectActionFlowMetadata } from "../harness-board/project-action-scope"
import type { FlowCatalog, FlowChatTask } from "../../shared/mods/flows/types"
import type { ModsManager } from "../mods/manager"
import type { FunctionModsManager } from "../mods/v2/manager"
import { NativeFlowHost } from "../mods/flows/native-host"
import { FlowManager } from "../mods/flows/manager"
import { FlowStore } from "../mods/flows/store"
import { projectFlowExecutionEvidence } from "../mods/flows/execution-evidence"
import { ClawStore } from "../mods/claw-store"
import { resolveClawThread } from "../mods/claw-scope"
import { loadAgentProfilesAsync } from "../agent/agent-registry"
import { getModelConfigs } from "../models/registry"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import { listClawSkillSources } from "../mods/claw-skills"

export function assertOrdinaryFlowMetadata(metadata: Record<string, unknown>): void {
  if (!isOrdinaryFlowMetadata(metadata)) throw Error("DIY 流程当前只支持普通本地项目会话")
}

function boundedId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200) throw Error("FLOW_ID_INVALID")
  return value
}

async function featureCatalog(workspace: string): Promise<FlowCatalog["features"]> {
  let handle: Awaited<ReturnType<typeof openStableFileHandle>>
  try {
    handle = await openStableFileHandle(workspace, join(workspace, ".autobizdevops/state.json"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  try {
    const state = JSON.parse(
      (await readStableFileHandleBounded(handle, 2 * 1024 * 1024)).toString("utf8")
    )
    if (!state.features || typeof state.features !== "object" || Array.isArray(state.features))
      throw Error("AUTOBIZ_FEATURE_RECORD_INVALID")
    const entries = Object.entries(state.features)
    if (entries.length > 256) throw Error("AUTOBIZ_FEATURE_LIMIT")
    return entries.map(([id, item]) => {
      const checkpoint = (item as { checkpoint?: unknown })?.checkpoint
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) ||
        typeof checkpoint !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(checkpoint)
      )
        throw Error("AUTOBIZ_FEATURE_RECORD_INVALID")
      return { id, checkpoint }
    })
  } finally {
    await handle.handle.close()
  }
}

export function registerModsFlowHandlers(
  ipcMain: IpcMain,
  manager: ModsManager,
  functions: FunctionModsManager,
  access: {
    trusted(event: IpcMainInvokeEvent): void
    threadScope(threadId: string): string
    changed(threadId: string): void
  }
): FlowManager {
  const threadScope = (threadId: string) => {
    boundedId(threadId)
    const workspace = access.threadScope(threadId)
    const thread = getThreadCore(threadId)
    if (!thread) throw Error("MODS_THREAD_MISSING")
    const metadata =
      typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      throw Error("FLOW_SCOPE_INVALID")
    assertOrdinaryFlowMetadata(projectActionFlowMetadata(threadId, metadata) as Record<string, unknown>)
    return workspace
  }
  const scope = (event: IpcMainInvokeEvent, threadId: string) => {
    access.trusted(event)
    return threadScope(threadId)
  }
  const host = new NativeFlowHost(manager, functions, {
    scope: threadScope,
    changed: access.changed
  })
  const flows = new FlowManager(new FlowStore(manager.store), host)
  registerFlowFilePublicationHandlers(ipcMain, flows, {
    trusted: access.trusted,
    threadScope,
    captureThreadFence: (threadId) => {
      const row = getThreadCore(threadId)
      if (!row) throw Error("FLOW_FILE_SCOPE_CHANGED")
      const incarnation = captureThreadIncarnation(row)
      return () => {
        if (!matchesThreadIncarnation(getThreadCore(threadId), incarnation))
          throw Error("FLOW_FILE_SCOPE_CHANGED")
      }
    }
  })
  const catalogFence = (event: IpcMainInvokeEvent, threadId: string) => {
    const workspace = scope(event, threadId)
    const identity = resolveClawThread(threadId, getThreadCore)?.identity
    if (!identity) throw Error("FLOW_SCOPE_INVALID")
    const binding = new ClawStore(manager.store).selection(workspace, identity)
    return {
      workspace,
      selection: binding.profile,
      assertCurrent: () => {
        if (
          scope(event, threadId) !== workspace ||
          resolveClawThread(threadId, getThreadCore)?.identity !== identity ||
          new ClawStore(manager.store).selection(workspace, identity).revision !== binding.revision
        )
          throw Error("FLOW_SCOPE_CHANGED")
      }
    }
  }
  // Explicit discovery only: opening the editor must not initialize MCP transports.
  ipcMain.handle("mods:flow-mcp-tools", async (event, threadId: string) => {
    const fence = catalogFence(event, threadId)
    if (!manager.isEnabled(fence.workspace)) throw Error("MODS_DISABLED")
    const { listNativeMcpTools } = await import("../mods/flows/native-mcp")
    fence.assertCurrent()
    const tools = await listNativeMcpTools(fence.selection?.mcp)
    fence.assertCurrent()
    if (!manager.isEnabled(fence.workspace)) throw Error("MODS_DISABLED")
    const published = await manager.publish(fence.workspace, tools)
    fence.assertCurrent()
    return published
  })
  ipcMain.handle("mods:flow-catalog", async (event, threadId: string): Promise<FlowCatalog> => {
    const fence = catalogFence(event, threadId)
    const { workspace } = fence
    const [plugins, profiles, features, skills] = await Promise.all([
      functions.status(workspace),
      loadAgentProfilesAsync(workspace),
      featureCatalog(workspace),
      listClawSkillSources()
    ])
    fence.assertCurrent()
    const enabled = manager.isEnabled(workspace)
    const rows = plugins.map((plugin) => ({
      id: plugin.name,
      name: plugin.name,
      authorized: enabled && plugin.state === "ready"
    }))
    const catalog: FlowCatalog = {
      available: true,
      hostAvailable: enabled,
      workspace,
      ...(!enabled
        ? {
            reason: "请先开启灵件功能；使用内置流程无需另装灵件。"
          }
        : {}),
      plugins: rows,
      agents: profiles.map((profile) => ({
        id: profile.name,
        name: profile.name,
        description: profile.description
      })),
      models: getModelConfigs()
        .filter((model) => model.apiKey)
        .map((model) => ({ id: model.ref, name: model.name })),
      features,
      skills: skills.filter(
        (skill) =>
          fence.selection?.skills?.mode !== "selected" ||
          fence.selection.skills.items.some(
            (item) =>
              item.id === skill.id && item.name === skill.name && item.digest === skill.digest
          )
      )
    }
    catalog.actions = enabled ? await functions.actionCatalog(workspace, threadId, plugins) : []
    const published = await manager.publish(workspace, catalog)
    fence.assertCurrent()
    return published
  })
  ipcMain.handle("mods:flow-list", (event, threadId: string) => flows.list(scope(event, threadId)))
  ipcMain.handle(
    "mods:claw-start",
    (event, input: { threadId: string; expectedRevision: number; goal: string }) => {
      const workspace = scope(event, input?.threadId)
      const identity = resolveClawThread(input.threadId, getThreadCore, (path) =>
        manager.workspaceKey(path)
      )
      if (!identity || identity.threadId !== input.threadId) throw Error("CLAW_SCOPE_INVALID")
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
        throw Error("CLAW_REVISION_INVALID")
      const binding = new ClawStore(manager.store).selection(workspace, identity.identity)
      if (binding.revision !== input.expectedRevision)
        throw Error("Claw 绑定已变化，请核对当前版本后重新发送。")
      if (!binding.profile?.flow) throw Error("当前 Claw 没有绑定流程，请先配置并应用。")
      // No await between the binding check and startSaved's synchronous lease acquisition.
      return flows.startSaved(workspace, input.threadId, binding.profile.flow, {
        workspace,
        goal: input.goal
      })
    }
  )
  ipcMain.handle(
    "mods:flow-save",
    (
      event,
      input: {
        threadId: string
        definition: unknown
        expectedRevision: number
        expectedWorkspace?: string
      }
    ) => {
      const workspace = scope(event, input?.threadId)
      if (input.expectedWorkspace !== undefined && input.expectedWorkspace !== workspace)
        throw Error("FLOW_SCOPE_CHANGED")
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
        throw Error("FLOW_REVISION_INVALID")
      // Task configuration grants no plugin capabilities and never changes mandatory application rules.
      return flows.save(workspace, input.definition, input.expectedRevision)
    }
  )
  ipcMain.handle(
    "mods:flow-start",
    (
      event,
      input: {
        threadId: string
        flowId: string
        revision: number
        task?: FlowChatTask
        expectedWorkspace?: string
      }
    ) => {
      const workspace = scope(event, input?.threadId)
      if (!Number.isSafeInteger(input.revision) || input.revision < 1)
        throw Error("FLOW_REVISION_INVALID")
      const flowId = boundedId(input.flowId)
      // Legacy host/UAT callers retain their existing scope semantics.
      if (input.expectedWorkspace === undefined)
        return flows.start(workspace, input.threadId, flowId, input.revision, input.task)
      if (typeof input.expectedWorkspace !== "string" || input.expectedWorkspace !== workspace)
        throw Error("FLOW_SCOPE_CHANGED")
      const threadId = input.threadId
      const row = getThreadCore(threadId)
      if (!row) throw Error("FLOW_SCOPE_CHANGED")
      const incarnation = captureThreadIncarnation(row)
      const sender = event.sender,
        frame = sender.mainFrame
      let revoked = false
      const revoke = () => {
        revoked = true
      }
      const navigate = (details: { isMainFrame: boolean; isSameDocument?: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) revoke()
      }
      const assertCurrent = () => {
        if (
          revoked ||
          sender.isDestroyed() ||
          sender.mainFrame !== frame ||
          event.senderFrame !== frame ||
          !matchesThreadIncarnation(getThreadCore(threadId), incarnation) ||
          scope(event, threadId) !== workspace
        )
          throw Error("FLOW_SCOPE_CHANGED")
      }
      assertCurrent()
      sender.once("destroyed", revoke)
      sender.on("did-start-navigation", navigate)
      const dispose = () => {
        sender.removeListener("destroyed", revoke)
        sender.removeListener("did-start-navigation", navigate)
      }
      return flows
        .start(workspace, threadId, flowId, input.revision, input.task, assertCurrent)
        .then(
          (result) => {
            void flows
              .waitForSettlement(workspace, threadId, result.id)
              .finally(dispose)
              .catch(() => {})
            assertCurrent()
            return result
          },
          (error) => {
            dispose()
            throw error
          }
        )
    }
  )
  ipcMain.handle("mods:flow-runs", (event, threadId: string) =>
    flows.runs(scope(event, threadId), threadId)
  )
  ipcMain.handle("mods:flow-evidence", (event, input: unknown) => {
    access.trusted(event)
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error("FLOW_EVIDENCE_INPUT_INVALID")
    const payload = input as Record<string, unknown>
    if (
      Object.keys(payload).length !== 2 ||
      Object.keys(payload).some((key) => !["threadId", "runId"].includes(key))
    )
      throw Error("FLOW_EVIDENCE_INPUT_INVALID")
    const threadId = boundedId(payload.threadId)
    const runId = boundedId(payload.runId)
    const workspace = scope(event, threadId)
    let view: ReturnType<typeof projectFlowExecutionEvidence> | undefined
    try {
      const history = new FlowStore(manager.store).runs(workspace, threadId)
      const run = history.find((row) => row.id === runId)
      if (run) view = projectFlowExecutionEvidence(run, history, manager.store)
    } catch {
      throw Error("FLOW_EVIDENCE_HISTORY_INVALID")
    }
    if (!view) throw Error("FLOW_RUN_MISSING")
    if (scope(event, threadId) !== workspace) throw Error("FLOW_SCOPE_CHANGED")
    return view
  })
  ipcMain.handle("mods:flow-run", (event, input: { threadId: string; runId: string }) =>
    flows.run(scope(event, input?.threadId), input.threadId, boundedId(input.runId))
  )
  ipcMain.handle(
    "mods:flow-recovery",
    async (event, input: { threadId: string; runId: string }) => {
      const workspace = scope(event, input?.threadId)
      const result = await flows.recovery(workspace, input.threadId, boundedId(input.runId))
      if (scope(event, input.threadId) !== workspace) throw Error("FLOW_SCOPE_CHANGED")
      return result
    }
  )
  ipcMain.handle("mods:flow-resume", async (event, input: unknown) => {
    access.trusted(event)
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error("FLOW_RESUME_INPUT_INVALID")
    const payload = input as Record<string, unknown>
    if (
      Object.keys(payload).length !== 3 ||
      Object.keys(payload).some(
        (key) => !["threadId", "runId", "expectedSourceDigest"].includes(key)
      )
    )
      throw Error("FLOW_RESUME_INPUT_INVALID")
    const threadId = boundedId(payload.threadId)
    const runId = boundedId(payload.runId)
    const digest = payload.expectedSourceDigest
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
      throw Error("FLOW_RECOVERY_DIGEST_INVALID")
    const workspace = scope(event, threadId)
    const result = await flows.resume(workspace, threadId, runId, digest)
    if (scope(event, threadId) !== workspace) throw Error("FLOW_SCOPE_CHANGED")
    return result
  })
  ipcMain.handle(
    "mods:flow-decide",
    (event, input: { threadId: string; runId: string; nonce: string; approve: boolean }) => {
      const workspace = scope(event, input?.threadId)
      if (typeof input.approve !== "boolean") throw Error("FLOW_DECISION_INVALID")
      return flows.decide(
        workspace,
        input.threadId,
        boundedId(input.runId),
        boundedId(input.nonce),
        input.approve
      )
    }
  )
  ipcMain.handle("mods:flow-cancel", (event, input: { threadId: string; runId: string }) =>
    flows.cancel(scope(event, input?.threadId), input.threadId, boundedId(input.runId))
  )
  return flows
}
