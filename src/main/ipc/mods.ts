import { withTrustedFunctionWait } from "../mods/v2/trusted-function-wait"
import { setProjectRuntimeFunctions } from "../harness-board/project-runtime-function-source"
import { ApplicationCompletionPolicies } from "../mods/v2/application-completion-policy"
import { createHostProjectInputIdentity } from "../harness-board/project-runtime/package-input-identity"
import { readModsChatDisplayCapability } from "./mods-display-capability"
import { registerBuiltinAdvisorHandlers } from "./builtin-advisor"
import { registerCommunityExampleHandlers } from "./mods-community-examples"
import { registerPluginStartUseHandlers } from "./plugin-start-use"
import { PluginStartUseService } from "../plugins/plugin-start-use"
import { pluginStartUseDestinationConfigurationIssues, pluginStartUseDependencyIssues } from "../plugins/plugin-start-use-diagnostics"
import { projectRuntimeDependencies } from "../harness-board/project-runtime-dependencies"
import { pluginChatStartUseEntries } from "../plugins/plugin-chat-start-use"
import { notifyHooksChanged } from "../hooks/notifications"
import { invalidateGlobalMcpCapabilityService } from "../mcp/capability-service"
import { listPluginSkills } from "./skills"
import { getEnabledPluginSkillSourceMetadata } from "../storage"
import { readNativeSkillUsagePolicy } from "../plugins/native-skill-usage"
import { bundledCommunityExamplesRoot } from "../mods/community-examples"
import { registerSkillEvaluationHandlers } from "./mods-skill-evaluation"
import { createSkillEvaluationService } from "../mods/evaluation/skill-factory"
import { registerEvaluationHandlers } from "./mods-evaluation"
import { createEvaluationRunner } from "../mods/evaluation/factory"
import { registerAuthoringReconcileHandlers } from "./mods-authoring-reconcile"
import { registerAuthoringInstallHandlers } from "./mods-authoring-install"
import { registerAuthoringRetentionHandlers } from "./mods-authoring-retention"
import { createAuthoringInstallService } from "../mods/devtools/authoring-install-factory"
import { FunctionPromptBroker } from "../mods/v2/prompt-broker"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { readNativeChildModsContext, readNativeChildModsThread } from "../agent/native-child-mods-context"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { readCurrentFunctionConversationCheckpoint } from "../mods/v2/conversation-checkpoint-host"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { registerPromptComposerHandlers } from "./mods-prompt"
import { FunctionDesktopBroker } from "../mods/v2/desktop-broker"
import { nativePlatformProviders } from "../mods/v2/platform-native-providers"
import { createProjectStageDebugPlatformProvider } from "../mods/v2/platform-project-stage-debug-provider"
import {
  createNativeProjectRuntimePlatformProvider,
  executeProjectRuntimeNativeCommand
} from "../mods/v2/platform-project-runtime-native"
import { ProjectStageDebugReviewHub } from "../mods/v2/project-stage-debug-review-hub"
import { getProjectStageDebugSessions } from "../mods/devtools/project-stage-debug"
import { writeFunctionClipboard } from "../mods/v2/native-clipboard"
import { registerDesktopHandlers } from "./mods-desktop"
import { registerFunctionConfigHandlers } from "./mods-config"
import { captureFunctionMarkdownFrame, withFunctionMarkdownDisplay } from "../mods/v2/markdown-display-scope"
import { functionMarkdownIpcLink, functionMarkdownIpcReceipt } from "../mods/v2/markdown-ipc-input"
import { functionMarkdownUrlTransform } from "../../shared/mods/v2/markdown"
import { createComposerPermissionScope } from "../mods/v2/composer-permission-scope"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { writeFunctionModDebugLog } from "../logging"
import { gitNoticeFunctionConfig } from "../mods/v2/git-notice-config"
import { registerClawHandlers } from "./mods-claw"
import { isClawThread, resolveClawThread } from "../mods/claw-scope"
import { resolveCapabilityContext } from "../mods/capability-context"
import { getHarnessCapabilityWorkspaces, getHarnessCapabilityFeatureWorkspace } from "../harness-board/service"
import { listLocalThreadRunLeases, getLocalThreadRunLease,
  onLocalThreadRunLeaseReleased, claimLocalThreadRunLease,
  releaseLocalThreadRunLease, captureLocalThreadRunLease } from "../agent/thread-run-lease"
import { queryFunctionAgentList } from "../mods/v2/agent-list-host"
import { inspectAutobizEnvironment } from "../mods/v2/autobiz-environment"
import { prepareFunctionSessionTitle } from "../mods/v2/session-title"
import { nativeFunctionDialogAccess } from "../mods/v2/native-dialog-access"
import { compactFunctionSession, queryFunctionSessionRead } from "../mods/v2/session-read-host"
import { queryFunctionToolCatalog } from "../mods/v2/tool-catalog-host"
import { app, dialog, clipboard, safeStorage, shell, BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { join } from "node:path"
import { writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import {
  getDb, getThreadCore, getThreadRuntimeScope, getThreadMessagesByIds, getUserMessagePromptOrigin
} from "../db"
import { functionConversationTranscriptFields, isFunctionConversationNotice } from
  "../../shared/mods/v2/conversation-transcript"
import {
  getModsGlobalEnabled,
  getGitChangeNoticeSetting,
  setGitChangeNoticeEnabled,
  getOpenworkDir,
  getPlugins,
  setPluginEnabled,
  getPluginsDir,
  getInstalledPluginIds,
  setModsGlobalEnabled,
  getStoredDefaultModelId,
  getStoredAgentGraphRecursionLimit,
  getWindowsSandboxMode
} from "../storage"
import { ModsManager, setModsManager, setModsUnavailable } from "../mods/manager"
import { ModError, modErrorCode } from "../mods/errors"
import { installPluginFromDir } from "./plugins"
import { CreatorProjectDeliveries } from "../mods/devtools/creator-project-delivery"
import { CreatorSourceSets } from "../mods/devtools/creator-source-set"
import { observeProjectDeliveryInstallation, readProjectDeliveryInventory } from "../plugins/plugin-delivery-observation"
import { withPluginCatalogMutation } from "../plugins/catalog-mutation"
import { bundledModExamplesRoot } from "../mods/bundled-examples"
import { readManagedModDeployment } from "../mods/policy"
import { ModCommandQueue } from "../mods/command-queue"
import { bindStandaloneModCommand } from "../mods/command-backend"
import { withFunctionMcpCommand } from "../mods/v2/mcp-command"
import { withFunctionCommandBinding } from "../mods/v2/command-binding"
import { withFunctionAgentCommand } from "../mods/v2/agent-command"
import {
  functionExecutionScope,
  captureFunctionExecutionGuard,
  recordFunctionCancellationReceipt
} from "../mods/v2/execution-context"
import { functionCallTurn, functionCallIdentity, functionCallAuthority, functionCallAgent,
  withFunctionTransportExecution, runFunctionHostCall, observeFunctionProcess } from "../mods/v2/host-call"
import { encodeModJson, parseModJson } from "../../shared/mods/validation"
import type { ModCommandDescriptor, ModJson, ModObject } from "../../shared/mods/types"
import { resolveAgentModeFromMetadata } from "../../shared/agent-mode-metadata"
import { FunctionModsManager } from "../mods/v2/manager"
import { FunctionRuntimeClient } from "../mods/v2/runtime-client"
import { createFunctionPluginPromptHost } from "../mods/v2/plugin-prompt-host"
import { scheduleFunctionCommand } from "../mods/v2/command-scheduler"
import type { FunctionUiAction } from "../../shared/mods/v2/ui"
import type { FunctionClientAction } from "../../shared/mods/v2/ui"
import { scheduleFunctionTool, withFunctionExecution } from "../mods/v2/execution-context"
import { functionSdkToolInput } from "../mods/v2/tool-sdk"
import type { FunctionMcpToolDispatch } from "../mods/v2/mcp-sdk"
import { routeFunctionMcp } from "../mods/v2/mcp-tool-routing"
import type { ModGrant } from "../mods/control-store"
import { randomUUID } from "node:crypto"
import { FunctionModels } from "../mods/v2/models"
import { prepareFunctionModelPrompt } from "../mods/v2/model-prompt"
import {
  invokeFunctionFork,
  invokeFunctionModel,
  resolveFunctionModel
} from "../mods/v2/model-provider"
import type { FunctionModelForkSnapshot } from "../mods/v2/model-operations"
import { FunctionRegisteredTools } from "../mods/v2/registered-tools"
import { queryFunctionToolPermission } from "../mods/v2/tool-permission-host"
import { confirmFunctionProcess } from "./mods-process-approval"
import { functionFileScope } from "../mods/v2/file-permission-host"
import { assertWorkflowResourceProcess } from "../mods/v2/workflow-resource-access"
import { currentWorkflowWorktreeActionScope } from "../agent/workflow/worktree-action-scope"
import { assertFunctionMcpServerAvailable } from "../mods/v2/mcp-names"
import { getGlobalMcpCapabilityService } from "../mcp/capability-service"
import { registerModsFlowHandlers } from "./mods-flows"
import { normalizeProjectActionRuntime, setProjectActionRuntime } from "../harness-board/project-action-runtime"
import { FlowStore } from "../mods/flows/store"
import { readBuiltinPolicyDecisions, registerBuiltinPolicyScopeResolver } from "../mods/builtins/policy-decisions"
import { readBuiltinLegacyMetrics } from "../mods/builtins/legacy-metrics"
import { createLegacyModsRuntime, registerLegacyModsRuntime } from "../harness-board/project-runtime/legacy-mods-runtime"
import { prepareProjectActionSelection } from "../harness-board/project-action-selection"
import { projectActionFlowMetadata } from "../harness-board/project-action-scope"
import { ClawStore } from "../mods/claw-store"
import type { ClawProfile } from "../../shared/mods/claw"
import type { DevelopmentScope } from "../mods/v2/development-session"
import { registerModsAuthoringHandlers } from "./mods-authoring"
import { registerModsDevelopmentHandlers } from "./mods-development"
import { ModDevelopmentService, setModDevelopmentService } from "../mods/devtools/development-service"
import { CreatorPlanningService } from "../mods/devtools/creator-planning"
import { goalManager } from "../agent/goals/runtime"
import {
  CreatorCompositionService,
  getCreatorCompositionService,
  setCreatorCompositionService
} from "../mods/devtools/creator-composition"
import { isDevelopmentThreadMetadata } from "../../shared/mods/development-scope"
import { CreatorCompositionHistory } from "../mods/devtools/creator-composition-history"
import { CreatorReuseService } from "../mods/devtools/creator-reuse"
import { CreatorBusinessService, setCreatorBusinessService } from "../mods/devtools/creator-business"
import { CreatorBusinessTrials } from "../mods/devtools/creator-business-trial"
import { PluginStageRecoverySessions } from "../mods/devtools/plugin-stage-recovery"
import { registerPluginStageRecoveryHandlers } from "./plugin-stage-recovery"
import { registerCreatorBusinessTrialHandlers } from "./creator-business-trial"
import { isInternalHarnessProjectId } from "../harness-board/internal-project-context"
import { BusinessModAssemblyService } from "../plugins/business-mod-assembly-service"
import { inspectCompletePluginDirectory, installDerivedPluginDirectory } from "./plugins"
import { invalidateEnabledSkillsCache, invalidatePluginHooksCache } from "../storage"
import { CreatorUserConfigService, setCreatorUserConfigService } from "../mods/devtools/creator-user-config"
import { projectAuthoringSessions } from "../mods/devtools/project-authoring-session"
import { projectPreviewRegistry } from "../mods/devtools/project-preview-registry"
import { configureExtensionContextDirectoryBinding } from "../harness-board/extension-context"
import { readInternalHarnessDirectoryUserConfig, admitInternalHarnessContextSource } from "../harness-board/internal-project-user-config"
import { CreatorTrialUndoScheduler } from "../mods/devtools/creator-trial-undo"
import { claimConfigurationReload } from "../mods/v2/configuration-reload-lease"
import { publishDevelopmentTurnSettlement } from "../mods/v2/development-turn-settlement"
import { registerModsAuthoringPreviewHandlers } from "./mods-authoring-preview"
import { AuthoringDraftStore } from "../mods/devtools/authoring-store"
import { getPendingUserInputForThread } from "../services/user-input"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { registerRuntimeSessionHandlers } from "./mods-runtime-sessions"
import { registerSnapshotMaintenanceHandlers } from "./mods-snapshot-maintenance"
import {
  prepareSnapshotMaintenance,
  inspectSnapshotGarbage,
  collectSnapshotGarbage
} from "../harness-board/project-runtime/snapshot-retention"
import { auditProjectSnapshotReferences } from "../harness-board/project-runtime/snapshot-reference-audit"
import { auditNativeSnapshotReferences } from "../harness-board/project-runtime/snapshot-native-references"
import { registerPlatformFileEditSink } from "../mods/v2/platform-native-file-edits"
import { registerPlatformHandlers } from "./mods-platform"
import { runPlatformUserAction } from "../mods/v2/platform-user-action"
import { configureWorkflowDeterministicActions } from "../agent/workflow/deterministic-action-native"
import { builtinInstructionsStore } from "../mods/builtins/instructions"
import { builtinChangeReviewService } from "../mods/builtins/change-review"
import { projectBuiltinRunOverview } from "../mods/builtins/overview"
import { describeDevClawBuiltins } from "../mods/builtins/registry"
import { readBuiltinProjectBinding, readBuiltinProjectFacts } from "../mods/builtins/project-facts"

export function registerModsHandlers(ipcMain: IpcMain, window: () => BrowserWindow | null): void {
  let reconcileCreatorReuse: ((threadId?: string) => void) | undefined
  const snapshotAudit = (root: string) =>
    auditProjectSnapshotReferences(getOpenworkDir(), root, () => auditNativeSnapshotReferences(getDb()))
  registerSnapshotMaintenanceHandlers(ipcMain, {
    trusted,
    base: getOpenworkDir,
    prepare: prepareSnapshotMaintenance,
    previewAudit: (roots) => snapshotAudit(roots[0]),
    inspect: (root, previewReferences) => {
      const view = inspectSnapshotGarbage(root, () => previewReferences ?? snapshotAudit(root))
      return { ...view, published: view.publishedBefore }
    },
    collect: (root, expected) => collectSnapshotGarbage(root, () => snapshotAudit(root), expected)
  })
  let manager: ModsManager
  try {
    manager = new ModsManager(
      join(getOpenworkDir(), "mods-control.sqlite"),
      getPlugins,
      async (_threadId, modId, toolId, args, signal, reason) => {
        const owner = window()
        if (!owner || owner.isDestroyed()) return false
        const result = await dialog.showMessageBox(owner, {
          signal,
          type: "question",
          title: modId.startsWith("flow:") ? "批准流程操作" : "批准插件操作",
          message: modId.startsWith("flow:")
            ? `当前 DIY 流程请求执行 ${toolId}`
            : `插件 ${modId} 请求执行 ${toolId}`,
          detail: [reason, JSON.stringify(args, null, 2)].filter(Boolean).join("\n\n"),
          buttons: ["拒绝", "允许本次操作"],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        return result.response === 1
      },
      (threadId, scope) => window()?.webContents.send("mods:cards-changed", { threadId, ...(scope === undefined ? {} : { scope }) }),
      join(__dirname, "mod-host.js"),
      readManagedModDeployment(join(__dirname, "../resources/mods-policy.json")),
      getModsGlobalEnabled
    )
  } catch (error) {
    const code = error instanceof ModError ? modErrorCode(error) : "MODS_CONTROL_RECOVERY_REQUIRED"
    setModsUnavailable(code)
    ipcMain.handle("mods:status", (event) => {
      trusted(event)
      return {
        workspace: "",
        globalEnabled: false,
        enabled: false,
        outputPolicy: true,
        mods: [],
        diagnostics: [],
        recovery: code
      }
    })
    ipcMain.handle("mods:chat-display-capability", (event) => {
      trusted(event)
      throw new ModError(code)
    })
    ipcMain.handle("mods:global-enabled", (event) => {
      trusted(event)
      return false
    })
    ipcMain.handle("mods:configure-global", (event) => {
      trusted(event)
      throw new ModError(code)
    })
    ipcMain.handle("mods:function-unlocked", (event) => {
      trusted(event)
      return false
    })
    ipcMain.handle("mods:unlock-function", (event) => {
      trusted(event)
      return false
    })
    return
  }
  setModsManager(manager)
  const stopPolicyObservations = registerBuiltinPolicyScopeResolver(threadId => {
    const thread = getThreadCore(threadId)
    if (!thread) return undefined
    const workspace = writableThreadScope(threadId)
    if (!workspace) return undefined
    return { threadId, workspace, incarnationKey: JSON.stringify(captureThreadIncarnation(thread)) }
  })
  const registeredTools = new FunctionRegisteredTools(manager.store, {
    assertScope: (workspace, threadId) => {
      manager.functionToolAgent(workspace, threadId)
      if (!manager.isEnabled(workspace) || writableThreadScope(threadId) !== workspace)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    },
    admit: async (identity, tool, input, signal, caller) => {
      if (manager.protects(identity.workspace))
        await manager.policy.admit(identity, tool, input, signal)
      await manager.authorizeRegisteredTool(identity, tool, input, signal, caller)
    },
    publish: async (identity, value, signal) => {
      if (manager.protects(identity.workspace))
        return manager.policy.publish(value, identity.callId, signal, (digest, rules) =>
          manager.store.publication(identity.callId, digest, rules, "published")
        )
      manager.store.publication(identity.callId, "", [], "published")
      return value
    }
  })
  const models = new FunctionModels(manager.store, {
    captureStartup: (workspace, threadId) => functions.captureStartupModelGuard(workspace, threadId),
    assertScope: (workspace, threadId) => {
      if (!manager.isEnabled(workspace)) throw new ModError("MODS_DISABLED")
      if (writableThreadScope(threadId) !== workspace) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    },
    resolve: (name, workspace, threadId) => {
      const bound = manager.clawProfile(workspace, threadId)?.models?.default
      return resolveFunctionModel(name === "default" && bound ? bound : name)
    },
    captureModel: async (workspace, threadId, config) => {
      const profile = manager.clawProfile(workspace, threadId)
      if (!profile?.models) return () => {}
      const { getModelConfigByRef, getDefaultModelConfig } = await import("../models/registry")
      const { createClawModelGuard } = await import("../agent/claw-model-policy")
      const baseline = profile.models.default ? getModelConfigByRef(profile.models.default) : getDefaultModelConfig()
      if (!baseline?.apiKey) throw new ModError("CLAW_MODEL_UNAVAILABLE")
      const guard = createClawModelGuard(profile, baseline, getModelConfigByRef)!
      return () => guard(config)
    },
    invoke: invokeFunctionModel,
    prepare: (config, request, snapshot, identity, signal, assertLive) =>
      prepareFunctionModelPrompt(config, request, snapshot,
        (event, input, active, core) =>
          manager.promptComposition(identity.workspace, identity.threadId, event, input, active, core),
        signal, assertLive,
        async (input) => {
          if (manager.protects(identity.workspace))
            await manager.policy.admit(identity, "model.complete", input, signal)
        }),
    admit: async (identity, input, signal) => {
      if (manager.protects(identity.workspace))
        await manager.policy.admit(identity, "model.complete", input, signal)
    },
    publish: async (identity, value, signal) => {
      if (manager.protects(identity.workspace))
        return manager.policy.publish(value, identity.callId, signal, (digest, rules) =>
          manager.store.publication(identity.callId, digest, rules, "published")
        )
      manager.store.publication(identity.callId, "", [], "published")
      return value
    },
    captureForkSnapshot: (workspace, threadId) => captureForkSnapshot(workspace, threadId),
    invokeFork: (config, request, snapshot, signal) =>
      invokeFunctionFork(config, request, snapshot, signal)
  })
  const promptBroker = new FunctionPromptBroker()
  const desktopBroker = new FunctionDesktopBroker(text => writeFunctionClipboard(clipboard, text))
  registerDesktopHandlers(ipcMain, desktopBroker, writableScope)
  registerPromptComposerHandlers(ipcMain, promptBroker, writableScope, {
    support: (workspace, threadId) => manager.hasFunctionEvent(workspace, threadId, "prompt.edit"),
    run: async (workspace, threadId, input, signal, assertOwner, nativeCursor) =>
      await manager.editComposerPrompt(workspace, threadId, input, signal, assertOwner, nativeCursor) as
        import("../../shared/mods/v2/prompt-edit").FunctionPromptEditResult
  })
  const pluginPrompts = createFunctionPluginPromptHost(manager, (workspace, threadId) => {
    if (writableThreadScope(threadId) !== workspace) throw new ModError("MODS_CALL_SCOPE_CHANGED")
  })
  const conversations = new FunctionConversationCoordinator(new FunctionConversationStore(getDb()), {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: context => {
      if (!manager.isEnabled(context.workspace) ||
        writableThreadScope(context.threadId) !== context.workspace)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    },
    readCurrentCheckpoint: readCurrentFunctionConversationCheckpoint,
    protect: async (context, value, signal, guard) => {
      guard()
      const result = await manager.publish(context.workspace, value, undefined, signal)
      guard()
      return result
    },
    apiMessages: projectFunctionSessionApiMessages,
    changed: (threadId, uuid) => {
      const target = window()
      if (!target || target.isDestroyed()) return
      target.webContents.send("threads:changed")
      if (!uuid) return
      const thread = getThreadCore(threadId)
      const message = getThreadMessagesByIds(threadId, [uuid])[0]
      if (!thread || !message || message.role !== "system") return
      const fields = functionConversationTranscriptFields(message, message.id, message.role)
      if (fields.function_row_invalid || !fields.function_row || !isFunctionConversationNotice(fields))
        return
      target.webContents.send("mods:conversation-notice", {
        threadId, incarnation: captureThreadIncarnation(thread), message
      } satisfies import("../../shared/mods/v2/conversation-notice").FunctionConversationNoticeEvent)
    }
  })
  manager.setFunctionConversations(conversations)
  const stageDebugReviews = new ProjectStageDebugReviewHub(intent => {
    const target = window()
    if (!target || target.isDestroyed()) return false
    target.webContents.send("mods:project-stage-debug-review", intent)
    return true
  }, async intent => {
    const creator = development.projectAuthoringContext(intent.threadId)
    creator.assertCurrent()
    if (creator.scope.workspace !== intent.workspace ||
      JSON.stringify(creator.scope.incarnation) !== JSON.stringify(intent.incarnation) ||
      !manager.isEnabled(intent.workspace)) throw Error("PROJECT_STAGE_DEBUG_REVIEW_STALE")
    const sources = await functions.status(intent.workspace)
    creator.assertCurrent()
    if (!sources.some(source => source.name === intent.caller.name && source.digest === intent.caller.digest &&
      source.state === "ready")) throw Error("PROJECT_STAGE_DEBUG_REVIEW_STALE")
  })
  ipcMain.handle("mods:project-stage-debug-review-current", async (event, threadId: unknown) => {
    trusted(event)
    if (typeof threadId !== "string" || !threadId || threadId.length > 256)
      throw Error("PROJECT_STAGE_DEBUG_PUBLIC_INPUT_INVALID")
    const context = development.projectAuthoringContext(threadId)
    context.assertCurrent()
    const intent = await stageDebugReviews.current(threadId, context.scope.workspace, context.scope.incarnation)
    context.assertCurrent()
    return intent
  })
  const functions = new FunctionModsManager(
    manager.store,
    {
      platformNativeProviders: () => [...nativePlatformProviders(async (context, runId) => {
        context.assertCurrent()
        const owner = window()
        if (!owner || owner.isDestroyed()) return false
        const result = await dialog.showMessageBox(owner, {
          signal: context.signal, type: "question", title: "取消工作流",
          message: `插件 ${context.caller.name} 请求取消当前会话的工作流`,
          detail: `运行：${runId}\n取消后会等待原执行器完成资源清理，已产生的文件将按原规则保留。`,
          buttons: ["取消工作流", "保留运行"], defaultId: 1, cancelId: 1
        })
        context.assertCurrent()
        return result.response === 0
      }), createNativeProjectRuntimePlatformProvider(async request => {
        request.assertCurrent()
        const owner = window()
        if (!owner || owner.isDestroyed()) return { status: "rejected" }
        const labels = { continue: "连续执行项目", cancel: "停止当前步骤", reconcile: "核对执行结果" }
        const result = await dialog.showMessageBox(owner, {
          signal: request.context.signal,
          type: "question", title: labels[request.kind],
          message: `插件 ${request.context.caller.name} 请求${labels[request.kind]}`,
          detail: `项目：${request.projectId}\n版本：${request.expectedVersion}\n` +
            (request.kind === "continue"
              ? "最多继续 16 个阶段，新的执行或成果审批仍会停下等待确认。失败和未知结果不会自动重试。"
              : request.kind === "cancel"
                ? "请求停止不代表撤销已发生的文件修改或外部操作。"
                : "只核对已有执行事实与成果，不会授权重新执行。"),
          buttons: [labels[request.kind], "暂不处理"], defaultId: 1, cancelId: 1
        })
        request.assertCurrent()
        if (result.response !== 0) return { status: "rejected" }
        return executeProjectRuntimeNativeCommand(request)
      }), createProjectStageDebugPlatformProvider({
        creator: context => {
          context.assertCurrent()
          const creator = development.projectAuthoringContext(context.threadId)
          creator.assertCurrent()
          return { scope: creator.scope, guard: creator.assertCurrent }
        },
        debug: getProjectStageDebugSessions,
        drafts: scope => projectAuthoringSessions.list(scope).map(draft => ({
          id: draft.id, name: draft.name, revision: draft.revision, digest: draft.source.digest
        })),
        openReview: request => stageDebugReviews.request(request)
      })],
      plugins: getPlugins,
      freshClassicPluginSources: getPlugins,
      installedPluginIds: getInstalledPluginIds,
      threadIncarnationKey: (_workspace, threadId) => {
        const thread = getThreadCore(threadId)
        return thread ? JSON.stringify(captureThreadIncarnation(thread)) : undefined
      },
      debugLog: writeFunctionModDebugLog,
      openConversationOwner: (context) => {
        if (readNativeChildModsContext(context.threadId)) {
          assertFunctionDataScope(context.workspace, context.threadId)
          return () => undefined
        }
        return conversations.openConversationOwner(context)
      },
      activateConversationOwner: (context) => {
        if (readNativeChildModsContext(context.threadId)) {
          assertFunctionDataScope(context.workspace, context.threadId)
          return
        }
        conversations.activateConversationOwner(context)
      },
      appendSession: conversations.appendSession,
      readConversation: conversations.readConversation,
      reservePluginPrompt: pluginPrompts.reserve,
      userMessageOrigin: getUserMessagePromptOrigin,
      closePluginPrompts: pluginPrompts.close,
      preparePluginPrompt: (workspace, threadId, signal, assertResident, onInvalid, run) =>
        manager.withPluginPromptPreparation(workspace, threadId, signal, assertResident,
          onInvalid, run),
      secretProtector: safeStorage,
      configurationBusy: (threadId) => !!getLocalThreadRunLease(threadId) ||
        manager.functionTurns.hasUnsettled(threadId),
      configurationLogicalBusy: (threadId) => manager.functionTurns.hasUnsettled(threadId),
      onConfigurationIdle: (listener) => {
        const physical = onLocalThreadRunLeaseReleased((lease) => listener(lease.threadId))
        const logical = manager.functionTurns.onSettled(listener)
        return () => { physical(); logical() }
      },
      configChanged: (scope) => {
        getCreatorCompositionService()?.reconcile()
        reconcileCreatorReuse?.()
        if (scope === "schema") window()?.webContents.send("mods:configuration-changed", { scope })
        else window()?.webContents.send("mods:configuration-changed")
      },
      configRows: () => [gitNoticeFunctionConfig(getGitChangeNoticeSetting,
        setGitChangeNoticeEnabled, current => {
          const owner = window()
          if (owner && !owner.isDestroyed()) owner.webContents.send("settings:git-change-notice-updated", current)
        })],
      prompt: promptBroker,
      desktop: desktopBroker,
      capturePromptGuard: (workspace, threadId) => {
        const owner = functionCallAuthority(workspace, threadId)
        const execution = captureFunctionExecutionGuard(workspace, threadId)
        const runtime = owner ? manager.captureFunctionRuntimeGuard(owner) : undefined
        return () => { execution(); runtime?.() }
      },
      version: { version: app.getVersion() },
      readSettings: async (workspace, threadId) => {
        assertFunctionDataScope(workspace, threadId)
        return {
          cmbdevclaw: {
            application: { version: app.getVersion() },
            workspace: { root: workspace },
            mods: {
              globalEnabled: getModsGlobalEnabled(),
              workspaceEnabled: manager.isEnabled(workspace)
            },
            model: { storedDefaultId: getStoredDefaultModelId() },
            runtime: {
              graphRecursionLimit: getStoredAgentGraphRecursionLimit(),
              windowsSandboxMode: getWindowsSandboxMode()
            }
          }
        }
      },
      checkpointTransition: (...args) => manager.runCompletionCheckpoint(...args),
      projectCheck: (...args) => manager.runCompletionProjectCheck(...args),
      dialogs: nativeFunctionDialogAccess,
      sendPeer: (...args) => manager.sendFunctionPeer(...args),
      prepareAgent: (workspace, threadId, grant, input, signal) =>
        runAgentCommand(workspace, threadId, grant, signal, () =>
          manager.prepareFunctionAgentSpawn(workspace, threadId, grant, input, signal)
        ),
      spawnAgent: (workspace, threadId, grant, input, signal, lifetime, creator) =>
        runAgentCommand(workspace, threadId, grant, signal, () =>
          manager.spawnFunctionAgent(workspace, threadId, grant, input, signal, lifetime, creator)
        ),
      runEffect: async (workspace, threadId, grant, method, input, signal, run) => {
        const assertLive = () => {
          signal.throwIfAborted()
          manager.store.assertGrant(grant)
          if (writableThreadScope(threadId) !== workspace)
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
        }
        assertLive()
        const identity = functionCallIdentity(workspace, threadId, grant, {
          origin: "mod",
          fallbackTurnId: `function-effect:${randomUUID()}`
        })
        return runFunctionHostCall({
          store: manager.store,
          identity,
          ...(method === "process.run" ? {
            processLifecycle: (event: import("../../shared/mods/process-lifecycle").ProcessLifecycleEvent) =>
              manager.store.recordProcessLifecycle(identity.callId, event)
          } : {}),
          assertLive,
          admit: async () => {
            if (manager.protects(workspace))
              await manager.policy.admit(identity, method, input, signal)
          },
          claim: () => manager.store.claim(identity.callId, method, input, identity),
          invoke: run,
          status: () => "succeeded",
          publish: async (value) => {
            if (manager.protects(workspace))
              return manager.policy.publish(value, identity.callId, signal, (digest, rules) =>
                manager.store.publication(identity.callId, digest, rules, "published")
              )
            manager.store.publication(identity.callId, "", [], "published")
            return value
          }
        })
      },
      authorizeHttp: async (workspace, threadId, grant, request, signal) => {
        const assertLive = () => {
          signal.throwIfAborted()
          manager.store.assertGrant(grant)
          if (writableThreadScope(threadId) !== workspace)
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
        }
        assertLive()
        const identity = functionCallIdentity(workspace, threadId, grant, {
          origin: "mod",
          fallbackTurnId: `function-http:${randomUUID()}`
        })
        if (manager.protects(workspace))
          await manager.policy.admit(identity, "http.fetch", { ...request }, signal)
        assertLive()
        const owner = window()
        if (!owner || owner.isDestroyed()) throw new ModError("MODS_HTTP_APPROVAL_UNAVAILABLE")
        const choice = await dialog.showMessageBox(owner, {
          signal,
          type: "question",
          title: "批准插件网络请求",
          message: `插件 ${grant.modId} 请求 ${request.method} ${request.url}`,
          detail: JSON.stringify(request, null, 2),
          buttons: ["拒绝", "允许本次请求"],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        assertLive()
        if (choice.response !== 1) throw new ModError("MODS_HTTP_DENIED")
      },
      authorizeProcess: async (workspace, threadId, grant, request, signal) => {
        const resourceGuard = assertWorkflowResourceProcess(workspace, threadId, request)
        const assertLive = () => {
          resourceGuard?.()
          signal.throwIfAborted()
          manager.store.assertGrant(grant)
          if (writableThreadScope(threadId) !== workspace)
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
        }
        assertLive()
        const identity = functionCallIdentity(workspace, threadId, grant, {
          origin: "mod",
          fallbackTurnId: `function-process:${randomUUID()}`
        })
        if (manager.protects(workspace))
          await manager.policy.admit(
            identity,
            "process.run",
            { ...request, argv: [...request.argv] },
            signal,
            (phase) => observeFunctionProcess(`policy-${phase}`)
          )
        assertLive()
        const owner = window()
        if (!owner || owner.isDestroyed()) throw new ModError("MODS_PROCESS_APPROVAL_UNAVAILABLE")
        try {
          await confirmFunctionProcess(grant.modId, request, {
            signal,
            tempRoot: app.getPath("userData"),
            assertCurrent: () => {
              assertLive()
              if (owner !== window() || owner.isDestroyed())
                throw new ModError("MODS_PROCESS_APPROVAL_UNAVAILABLE")
            },
            showDialog: (options) => {
              observeFunctionProcess("approval-waiting")
              return withTrustedFunctionWait("user-approval", signal, async () => {
                assertLive()
                if (owner !== window() || owner.isDestroyed())
                  throw new ModError("MODS_PROCESS_APPROVAL_UNAVAILABLE")
                const choice = await dialog.showMessageBox(owner, options)
                assertLive()
                return choice
              })
            },
            openPath: (path) => shell.openPath(path)
          })
          observeFunctionProcess("approval-allowed")
        } catch (error) {
          if (error instanceof ModError && error.code === "MODS_PROCESS_DENIED")
            observeFunctionProcess("approval-rejected")
          throw error
        }
        assertLive()
      },
      cwd: (workspace, threadId) => {
        assertFunctionDataScope(workspace, threadId)
        const resource = currentWorkflowWorktreeActionScope(workspace, threadId)
        if (resource) return resource.boundary.workspaceRoot
        return manager.functionRuntimeScope(workspace, threadId).workspace
      },
      fileScope: (workspace, threadId) =>
        functionFileScope(manager, assertStandaloneThread, workspace, threadId),
      filterTools: (workspace, threadId, tools) =>
        manager.filterFunctionTools(workspace, threadId, tools),
      assertToolNameAvailable: (workspace, threadId, plugin, name) => {
        if (writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        assertFunctionMcpServerAvailable(
          plugin,
          getGlobalMcpCapabilityService().configuredServerNames?.() ?? []
        )
        manager.assertFunctionToolNameAvailable(workspace, threadId, name)
      },
      registeredTool: (...args) => registeredTools.call(...args),
      abortTurn: async (workspace, threadId, grant, turnId, signal) => {
        signal.throwIfAborted()
        if (writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        manager.store.assertGrant(grant)
        manager.functionTurns.abort(workspace, threadId, turnId)
        recordFunctionCancellationReceipt()
      },
      prepareSessionTitle: (workspace, threadId, signal, assertCurrent) => {
        if (readNativeChildModsContext(threadId)) {
          signal.throwIfAborted()
          assertCurrent()
          assertFunctionDataScope(workspace, threadId)
          return undefined
        }
        const scope = manager.functionRuntimeScope(workspace, threadId)
        return prepareFunctionSessionTitle(
          threadId,
          () => {
            signal.throwIfAborted()
            assertCurrent()
            scope.assertLive()
            if (writableThreadScope(threadId) !== workspace)
              throw new ModError("MODS_CALL_SCOPE_CHANGED")
          },
          () => {
            for (const target of BrowserWindow.getAllWindows()) {
              try {
                if (!target.isDestroyed() && !target.webContents.isDestroyed())
                  target.webContents.send("threads:changed")
              } catch {
                console.warn("[Mods] Title committed but renderer notification was unavailable")
              }
            }
          },
          signal
        )
      },
      readSession: (workspace, threadId, method, signal, usageArgs) =>
        queryFunctionSessionRead(
          manager,
          assertStandaloneThread,
          () => {
            if (writableThreadScope(threadId) !== workspace)
              throw new ModError("MODS_CALL_SCOPE_CHANGED")
          },
          workspace,
          threadId,
          method,
          signal,
          undefined,
          usageArgs
        ),
      compactSession: (workspace, threadId, instructions, signal) =>
        compactFunctionSession(
          manager,
          assertStandaloneThread,
          () => {
            if (writableThreadScope(threadId) !== workspace)
              throw new ModError("MODS_CALL_SCOPE_CHANGED")
          },
          workspace,
          threadId,
          instructions,
          signal
        ),
      listAgents: (workspace, threadId, signal) =>
        queryFunctionAgentList(manager, workspace, threadId, signal, (bound) => {
          if (writableThreadScope(threadId) !== workspace)
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
          if (!bound) assertStandaloneThread(threadId)
        }),
      listTools: async (workspace, threadId, signal) => {
        signal.throwIfAborted()
        if (writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        return queryFunctionToolCatalog(
          manager,
          assertStandaloneThread,
          workspace,
          threadId,
          signal
        )
      },
      completeModel: (...args) => models.complete(...args),
      completeModelResult: (...args) => models.completeResult(...args),
      forkModelResult: (...args) => models.forkResult(...args),
      capability: async (workspace, threadId, grant, method, input, signal) => {
        manager.store.assertGrant(grant)
        if (method === "model.classify") {
          const value = await models.classify(workspace, threadId, grant, input, signal)
          return value ?? null
        }
        if (method === "model.fork")
          return (await models.fork(
            workspace,
            threadId,
            grant,
            input,
            signal
          )) as unknown as ModJson
        throw new ModError("MODS_MODEL_OPERATION_UNSUPPORTED")
      },
      checkTool: (workspace, threadId, grant, input, signal, registered) => {
        if (writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        manager.store.assertGrant(grant)
        return queryFunctionToolPermission(
          manager,
          assertStandaloneThread,
          workspace,
          threadId,
          grant,
          input,
          signal,
          registered
        )
      },
      callMcp,
      connectMcp: (workspace, threadId, grant, owner, signal, run) =>
        withMcpBinding(workspace, threadId, grant, signal, operationSignal =>
          run((input, active) => manager.connectFunctionMcp(workspace, threadId, grant,
            owner, String(input.server), AbortSignal.any([operationSignal, active]))),
        "mcp:connect"),
      enabled: (workspace) => manager.isEnabled(workspace),
      protects: (workspace) => manager.protects(workspace),
      pendingQuestion: (threadId) => getPendingUserInputForThread(threadId),
      captureSiteGuard: (workspace, threadId) => {
        const worker = readNativeChildModsContext(threadId)
        if (worker) {
          assertFunctionDataScope(workspace, threadId)
          return () => {
            worker.assertCurrent()
            assertFunctionDataScope(workspace, threadId)
          }
        }
        const row = getThreadRuntimeScope(threadId)
        if (!row || writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        const incarnation = captureThreadIncarnation(row)
        return () => {
          if (!matchesThreadIncarnation(getThreadRuntimeScope(threadId), incarnation) ||
            writableThreadScope(threadId) !== workspace)
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
        }
      },
      captureDisplayScope: (workspace, threadId) => {
        // Native child execution keeps its separate host identity protocol.
        if (readNativeChildModsContext(threadId)) return undefined
        const database = getDb(), row = getThreadRuntimeScope(threadId)
        if (!row || writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        const incarnation = captureThreadIncarnation(row)
        return { database, workspace, threadId, incarnation, assertCurrent: () => {
          if (getDb() !== database ||
            !matchesThreadIncarnation(getThreadRuntimeScope(threadId), incarnation) ||
            writableThreadScope(threadId) !== workspace)
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
        } }
      },
      creatorHook: (workspace, threadId) =>
        manager.functionModelHookSource(functionCallAuthority(workspace, threadId)),
      clawApplicable: (threadId) => functionClawScope(threadId) !== null,
      capabilityContext: functionCapabilityContext,
      clawScope: functionClawScope,
      publish: (workspace, value, signal) => manager.publish(workspace, value, undefined, signal),
      assertThread: (workspace, threadId) => {
        assertFunctionDataScope(workspace, threadId)
      },
      callDevelopmentTool: (workspace, threadId, activation, capability, input, signal) => {
        const { target, args } = functionSdkToolInput(input)
        if (target === "mcp:call") throw new ModFunctionError("MODS_MCP_TOOL_UNAVAILABLE")
        return scheduleFunctionTool(queue, workspace, threadId, target, signal,
          async (operationSignal, readOnly, userInitiated) => {
            if (writableThreadScope(threadId) !== workspace)
              throw new ModError("MODS_CALL_SCOPE_CHANGED")
            activation.assertCapability(capability)
            const execution = functionExecutionScope(workspace, threadId)
            manager.functionToolAgent(workspace, threadId)
            const invoke = () => manager.invokeDevelopmentTool(workspace, threadId,
              activation, capability, target, args, operationSignal, readOnly, userInitiated,
              typeof input.tool_use_id === "string" ? input.tool_use_id : undefined)
            if (execution?.turnId || !manager.needsCommandBinding(threadId)) return invoke()
            assertStandaloneThread(threadId)
            const turnId = functionCallTurn(workspace, threadId) ?? `development-tools:${randomUUID()}`
            return withFunctionCommandBinding("native", workspace, threadId, operationSignal,
              () => bindStandaloneModCommand(workspace, threadId, turnId, operationSignal),
              () => withFunctionExecution({ workspace, threadId, turnId, leased: true,
                immediate: readOnly, userInitiated }, invoke))
          })
      },
      callTool: (workspace, threadId, grant, input, signal) => {
        const { target, args } = functionSdkToolInput(input)
        if (target === "mcp:call") return callMcp(workspace, threadId, grant, input, signal)
        return scheduleFunctionTool(
          queue,
          workspace,
          threadId,
          target,
          signal,
          async (operationSignal, readOnly, userInitiated) => {
            if (writableThreadScope(threadId) !== workspace)
              throw new ModError("MODS_CALL_SCOPE_CHANGED")
            manager.store.assertGrant(grant)
            const execution = functionExecutionScope(workspace, threadId)
            manager.functionToolAgent(workspace, threadId)
            const invoke = () =>
              manager.invokeFunctionTool(
                workspace,
                threadId,
                grant,
                target,
                args,
                operationSignal,
                readOnly,
                userInitiated,
                typeof input.tool_use_id === "string" ? input.tool_use_id : undefined
              )
            if (execution?.turnId || !manager.needsCommandBinding(threadId)) return invoke()
            assertStandaloneThread(threadId)
            const turnId = functionCallTurn(workspace, threadId) ?? `function-tools:${randomUUID()}`
            return withFunctionCommandBinding(
              "native",
              workspace,
              threadId,
              operationSignal,
              () => bindStandaloneModCommand(workspace, threadId, turnId, operationSignal),
              () =>
                withFunctionExecution(
                  { workspace, threadId, turnId, leased: true, immediate: readOnly, userInitiated },
                  invoke
                )
            )
          }
        )
      },
      scheduleCommand: (workspace, threadId, command, signal, run) =>
        scheduleFunctionCommand(queue, workspace, threadId, command, signal, run),
      markdownPreviewInvalidated: (threadId, receipt) =>
        window()?.webContents.send("mods:markdown-preview-invalidated", { threadId, receipt }),
      platformChanged: (threadId) => window()?.webContents.send("mods:platform-changed", { threadId }),
      changed: (threadId, scope) => {
        getCreatorCompositionService()?.reconcile(threadId)
        reconcileCreatorReuse?.(threadId)
        window()?.webContents.send("mods:cards-changed", {
          threadId,
          ...(scope === undefined ? {} : { scope })
        })
      }
    },
    () => new FunctionRuntimeClient(join(__dirname, "function-mod-host.js"))
  )
  const queue = new ModCommandQueue(manager.store, (threadId) => {
    const owner = window()
    if (owner && !owner.isDestroyed()) owner.webContents.send("mods:jobs-changed", { threadId })
  })

  function runAgentCommand<T>(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    signal: AbortSignal,
    run: () => Promise<T>
  ): Promise<T> {
    const key = manager.workspaceKey(workspace)
    const epoch = manager.store.getSetting(`epoch:${key}`, "0")
    return withFunctionAgentCommand(
      {
        manager,
        assertLive: () => {
          signal.throwIfAborted()
          manager.store.assertGrant(grant)
          if (
            grant.workspace !== key ||
            writableThreadScope(threadId) !== key ||
            !manager.isEnabled(key) ||
            manager.store.getSetting(`epoch:${key}`, "0") !== epoch
          )
            throw new ModError("MODS_CALL_SCOPE_CHANGED")
        },
        assertStandalone: () => assertStandaloneThread(threadId)
      },
      key,
      threadId,
      signal,
      run
    )
  }

  function captureForkSnapshot(
    workspace: string,
    threadId: string
  ): FunctionModelForkSnapshot | null {
    const captured = manager.captureFunctionSession(workspace, threadId)
    let handedOff = false
    try {
      captured.assertLive()
      if (!captured.bound || !captured.messages?.length || !captured.model || !captured.modelRef)
        return null
      const messages: Array<FunctionModelForkSnapshot["messages"][number]> = []
      let bytes = 0
      for (const raw of captured.messages) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
        const value = raw as Record<string, unknown>
        const rawRole =
          typeof value.role === "string"
            ? value.role
            : typeof value.type === "string"
              ? value.type
              : typeof (value._getType as (() => string) | undefined) === "function"
                ? (value._getType as () => string)()
                : ""
        const role = rawRole === "human" ? "user" : rawRole === "ai" ? "assistant" : rawRole
        if (role !== "system" && role !== "user" && role !== "assistant") continue
        const content = value.content
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter(
                    (part): part is { type: "text"; text: string } =>
                      !!part &&
                      typeof part === "object" &&
                      !Array.isArray(part) &&
                      (part as Record<string, unknown>).type === "text" &&
                      typeof (part as Record<string, unknown>).text === "string"
                  )
                  .map((part) => part.text)
                  .join("")
              : ""
        if (!text) continue
        bytes += Buffer.byteLength(text, "utf8")
        if (bytes > 64000 || messages.length >= 256) break
        messages.push({ role, text })
      }
      if (messages.length === 0) return null
      const system = captured.request?.systemMessage
      const systemText =
        typeof system === "string"
          ? system
          : system && typeof system === "object" && "content" in system
            ? typeof (system as { content?: unknown }).content === "string"
              ? (system as { content: string }).content
              : undefined
            : undefined
      const snapshot: FunctionModelForkSnapshot = {
        messages,
        model: captured.model,
        modelRef: captured.modelRef,
        ...(systemText ? { system: systemText.slice(0, 16000) } : {}),
        assertLive: captured.assertLive,
        release: captured.release
      }
      handedOff = true
      return snapshot
    } finally {
      if (!handedOff) captured.release()
    }
  }

  function callMcp(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    signal: AbortSignal,
    dispatch?: FunctionMcpToolDispatch
  ): Promise<ModObject> {
    if (!dispatch)
      return withMcpBinding(
        workspace,
        threadId,
        grant,
        signal,
        (operationSignal, readOnly, userInitiated) =>
          manager.invokeFunctionMcpTool(
            workspace,
            threadId,
            grant,
            input,
            operationSignal,
            readOnly,
            userInitiated
          )
      )
    return routeFunctionMcp(input, signal, dispatch, {
      resolve: (value, lookupSignal) =>
        withMcpBinding(workspace, threadId, grant, lookupSignal, (operationSignal) =>
          manager.resolveFunctionMcp(workspace, threadId, grant, value, operationSignal)
        ),
      invoke: (value, callSignal, fingerprint) =>
        withMcpBinding(
          workspace,
          threadId,
          grant,
          callSignal,
          (operationSignal, readOnly, userInitiated) =>
            manager.invokeFunctionMcp(
              workspace,
              threadId,
              grant,
              value,
              operationSignal,
              readOnly,
              userInitiated,
              fingerprint
            )
        )
    })
  }

  function withMcpBinding(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    signal: AbortSignal,
    run: (signal: AbortSignal, readOnly: boolean, userInitiated: boolean) => Promise<ModObject>,
    operation = "mcp:call"
  ): Promise<ModObject> {
    return scheduleFunctionTool(
      queue,
      workspace,
      threadId,
      operation,
      signal,
      async (operationSignal, readOnly, userInitiated) => {
        if (writableThreadScope(threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        manager.store.assertGrant(grant)
        const execution = functionExecutionScope(workspace, threadId)
        manager.functionToolAgent(workspace, threadId)
        const invoke = () => run(operationSignal, readOnly, userInitiated)
        if (execution?.turnId) return invoke()
        assertStandaloneThread(threadId)
        const turnId = functionCallTurn(workspace, threadId) ?? `function-mcp:${randomUUID()}`
        return withFunctionMcpCommand(workspace, threadId, turnId, operationSignal, () =>
          withFunctionExecution(
            { workspace, threadId, turnId, leased: true, immediate: readOnly, userInitiated },
            invoke
          )
        )
      }
    )
  }
  const authoringInstall = createAuthoringInstallService(manager, functions)
  registerAuthoringRetentionHandlers(ipcMain, authoringInstall, {
    trusted,
    threadScope: writableThreadScope,
    captureThreadFence: (threadId) => {
      const thread = getThreadCore(threadId)
      if (!thread) throw Error("STALE")
      const incarnation = captureThreadIncarnation(thread)
      return () => {
        if (!matchesThreadIncarnation(getThreadCore(threadId), incarnation)) throw Error("STALE")
      }
    }
  })
  registerAuthoringInstallHandlers(ipcMain, authoringInstall, {
    trusted,
    threadScope: writableThreadScope,
    captureThreadFence: (threadId) => {
      const thread = getThreadCore(threadId)
      if (!thread) throw Error("STALE")
      const incarnation = captureThreadIncarnation(thread)
      return () => {
        if (!matchesThreadIncarnation(getThreadCore(threadId), incarnation)) throw Error("STALE")
      }
    }
  })
  registerAuthoringReconcileHandlers(ipcMain, authoringInstall, {
    trusted,
    threadScope: writableThreadScope,
    captureThreadFence: threadId => {
      const thread = getThreadCore(threadId)
      if (!thread) throw Error("STALE")
      const incarnation = captureThreadIncarnation(thread)
      return () => {
        if (!matchesThreadIncarnation(getThreadCore(threadId), incarnation)) throw Error("STALE")
      }
    }
  })
  registerModsAuthoringPreviewHandlers(ipcMain, new AuthoringDraftStore(manager.store), {
    trusted,
    threadScope: writableThreadScope,
    captureThreadFence: (threadId) => {
      const thread = getThreadCore(threadId)
      if (!thread) throw Error("AUTHORING_PREVIEW_SCOPE_CHANGED")
      const incarnation = captureThreadIncarnation(thread)
      return () => {
        if (!matchesThreadIncarnation(getThreadCore(threadId), incarnation))
          throw Error("AUTHORING_PREVIEW_SCOPE_CHANGED")
      }
    }
  })
  registerModsAuthoringHandlers(ipcMain, new AuthoringDraftStore(manager.store), {
    trusted,
    threadScope: writableThreadScope
  })
  const development = new ModDevelopmentService({
    drafts: new AuthoringDraftStore(manager.store), runtime: functions,
    historySettings: manager.store,
    requestGroup: threadId => {
      const goal = goalManager.getActive(threadId)
      return goal ? `goal:${goal.goalId}` : undefined
    },
    versionsRoot: join(getOpenworkDir(), "mod-development"),
    workerEntry: join(__dirname, "mods-authoring-preflight.js"),
    normalizeWorkspace: workspace => manager.workspaceKey(workspace),
    canRun: scope => manager.isEnabled(scope.workspace),
    context: threadId => {
      const workspace = writableThreadScope(threadId)
      const thread = getThreadCore(threadId)!
      const incarnation = captureThreadIncarnation(thread)
      const assertCurrent = () => {
        if (writableThreadScope(threadId) !== workspace ||
          !matchesThreadIncarnation(getThreadCore(threadId), incarnation))
          throw Error("DEVELOPMENT_SCOPE_CHANGED")
        const current = getThreadCore(threadId)!
        const metadata = typeof current.metadata === "string" ? JSON.parse(current.metadata) : current.metadata
        if (!isDevelopmentThreadMetadata(metadata ?? {}))
          throw Error("DEVELOPMENT_ORDINARY_LOCAL_THREAD_REQUIRED")
      }
      assertCurrent()
      return { scope: { workspace, threadId, incarnation }, assertCurrent }
    },
    changed: threadId => {
      const owner = window()
      if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed())
        owner.webContents.send("mods:development-changed", { threadId })
    }
  })
  functions.configureDevelopmentAccess({
    assertScope: scope => development.assertScope(scope),
    changed: scope => {
      const owner = window()
      if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed())
        owner.webContents.send("mods:development-changed", { threadId: scope.threadId })
    }
  })
  setModDevelopmentService(development)
  registerPluginStartUseHandlers(ipcMain, new PluginStartUseService({
    plugins: getPlugins,
    enable: async (pluginId, guard) => {
      guard()
      setPluginEnabled(pluginId, true)
      manager.pluginsChanged([pluginId])
      invalidateEnabledSkillsCache()
      invalidatePluginHooksCache()
      await invalidateGlobalMcpCapabilityService("plugin:start-use-enable")
      notifyHooksChanged("plugin-enabled-changed")
    },
    diagnostics: async (plugin, input, guard, destination) => {
      const facts = await functions.prepareRuntimeSourceFacts({ workspace: input.expectedWorkspace, plugin })
      guard()
      const dependencies = await projectRuntimeDependencies({
        root: plugin.path, workspace: input.expectedWorkspace, manager: functions,
        plugins: getPlugins, assertCurrent: guard
      }).review()
      const issues = pluginStartUseDependencyIssues(dependencies, {
        enabled: manager.isEnabled(input.expectedWorkspace),
        globallyEnabled: manager.isGloballyEnabled()
      })
      if (facts?.userConfig) {
        issues.push(...await pluginStartUseDestinationConfigurationIssues(destination, () => functions.userConfig(
          input.expectedWorkspace, input.threadId, plugin.id, new AbortController().signal, guard
        )))
      }
      guard()
      return issues
    },
    chatEntries: async (plugin, input, guard) => {
      guard()
      const sources = getEnabledPluginSkillSourceMetadata().filter(source =>
        source.pluginId === plugin.id && source.pluginRoot === plugin.path)
      const [mods, skills] = await Promise.all([
        functions.status(input.expectedWorkspace), listPluginSkills(sources)
      ])
      const usage = await readNativeSkillUsagePolicy([plugin], () => ({ usage: "chat", assertCurrent: guard }))
      guard()
      usage?.assertCurrent()
      return pluginChatStartUseEntries(plugin.id, mods,
        usage ? skills.filter(skill => usage.allowsSkill(skill.path)) : skills)
    }
  }), {
    trusted,
    normalizeWorkspace: workspace => manager.workspaceKey(workspace),
    context: threadId => {
      const context = development.reuseContext(threadId)
      return { workspace: context.scope.workspace, assertCurrent: context.assertCurrent }
    }
  })
  development.configurePlanning(new CreatorPlanningService({
    settings: manager.store,
    current: (threadId, workspace) => {
      const context = development.reuseContext(threadId)
      if (workspace !== undefined && context.scope.workspace !== workspace)
        throw Error("DEVELOPMENT_SCOPE_CHANGED")
      return context
    },
    catalog: workspace => functions.status(workspace),
    invoke: (workspace, selected, signal, guard) =>
      functions.creatorPlanningPrompt(workspace, selected, signal, guard),
    changed: threadId => window()?.webContents.send("mods:development-changed", { threadId })
  }))
  projectAuthoringSessions.configurePersistence(
    manager.store,
    join(app.getPath("userData"), "mods", "project-authoring"),
    join(app.getPath("userData"), "project-trials")
  )
  projectPreviewRegistry.configurePersistence(manager.store)
  development.configureProjectTrialStatus(threadId => {
    try { return projectAuthoringSessions.trialRequest(development.projectAuthoringContext(threadId).scope) }
    catch { return undefined }
  })
  configureExtensionContextDirectoryBinding((sourceRoot, workspace, _name, key, projectId) =>
    projectId && isInternalHarnessProjectId(projectId)
      ? readInternalHarnessDirectoryUserConfig(functions, value => manager.workspaceKey(value), {
          projectId, sourceRoot, workspace, key
        })
      : functions.readDirectoryUserConfig(manager.workspaceKey(workspace), sourceRoot, key),
    (sourceRoot, workspace, projectId) => admitInternalHarnessContextSource(functions,
      value => manager.workspaceKey(value), { sourceRoot, workspace, projectId }))
  const creatorUserConfig = new CreatorUserConfigService({
    settings: manager.store,
    context: threadId => development.projectAuthoringContext(threadId),
    normalizeWorkspace: workspace => manager.workspaceKey(workspace),
    read: ({ scope }, pluginId, signal, guard) =>
      functions.userConfig(scope.workspace, scope.threadId, pluginId, signal, guard),
    save: ({ scope }, binding, key, value, signal, guard) => functions.saveUserConfig(
      scope.workspace, scope.threadId, binding.pluginId, binding.digest, key, value,
      binding.revision, signal, guard),
    reset: ({ scope }, binding, key, signal, guard) => functions.resetUserConfig(
      scope.workspace, scope.threadId, binding.pluginId, binding.digest, key,
      binding.revision, signal, guard),
    apply: ({ scope }, binding, signal, guard) => functions.applyUserConfig(
      scope.workspace, scope.threadId, binding.pluginId, binding.digest,
      binding.revision, signal, guard),
    changed: threadId => {
      const owner = window()
      if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed())
        owner.webContents.send("mods:development-changed", { threadId })
    }
  })
  setCreatorUserConfigService(creatorUserConfig)
  development.configureConfigurationStatus(threadId => creatorUserConfig.status(threadId))
  const assertCreatorAuthorized = (scope: DevelopmentScope, profile: ClawProfile | null) => {
    if (!manager.isEnabled(scope.workspace)) throw Error("COMPOSITION_MODS_DISABLED")
    const runtime = functions.runtimeSessions(scope.threadId)
    if (runtime.error || runtime.sessions.some(session => session.threadId === scope.threadId &&
      session.workspace === scope.workspace && ["releasing", "stopped", "failed"].includes(session.state)))
      throw Error("COMPOSITION_RUNTIME_STOPPED")
    const installed = getPlugins()
    for (const capability of profile?.capabilities ?? []) {
      const grant = manager.store.getGrant(scope.workspace, `function:${capability.name}`)
      if (!grant?.enabled || grant.digest !== capability.digest ||
        !installed.some(plugin => plugin.id === capability.pluginId && plugin.enabled !== false))
        throw Error("COMPOSITION_AUTHORITY_CHANGED")
    }
  }
  const creatorComposition = new CreatorCompositionService({
    saveReuse: {
      trials: scope => functions.developmentStatus(scope),
      prepareReuse: async (threadId, dependency, input) => {
        const status = await development.requestReuse(threadId, dependency.draftId,
          dependency.revision, input.turnId, input.signal, input.assertTurn)
        if (!status.reuse) throw Error("COMPOSITION_REUSE_UNAVAILABLE")
        return status.reuse
      },
      reuseFacts: scope => creatorReuse.compositionFacts(scope)
    },
    store: new ClawStore(manager.store),
    history: new CreatorCompositionHistory(manager.store),
    context: threadId => development.projectAuthoringContext(threadId),
    readContext: threadId => development.reuseContext(threadId),
    assertScope: scope => development.assertScope(scope),
    assertAuthorized: assertCreatorAuthorized,
    runtimeReady: (scope, profile) =>
      functions.selectionRuntimeReady(scope.workspace, scope.threadId, profile),
    identity: threadId => {
      const selected = resolveClawThread(threadId, getThreadCore,
        workspace => manager.workspaceKey(workspace))
      if (!selected || selected.threadId !== threadId) throw Error("COMPOSITION_SCOPE_CHANGED")
      return selected.identity
    },
    usage: functionCapabilityContext,
    available: workspace => functions.status(workspace),
    selectionCatalog: async workspace => {
      const [{ listClawSkillSources }, { readClawMcpSources }, registry] = await Promise.all([
        import("../mods/claw-skills"), import("../mods/claw-mcp"), import("../models/registry")
      ])
      return {
        models: registry.getModelConfigs().filter(model => !!model.apiKey)
          .map(model => ({ id: registry.toModelRef(model), name: model.name })),
        skills: await listClawSkillSources(), mcp: readClawMcpSources(),
        flows: new FlowStore(manager.store).list(workspace)
      }
    },
    issues: (workspace, profile, available) => functions.clawSelectionIssues(
      workspace, profile, available, "chat"),
    busy: threadId => !!getLocalThreadRunLease(threadId) ||
      manager.functionTurns.hasUnsettled(threadId) || functions.configurationBusy(threadId),
    onIdle: listener => {
      const physical = onLocalThreadRunLeaseReleased(lease => listener(lease.threadId))
      const logical = manager.functionTurns.onSettled(listener)
      const guest = functions.onConfigurationIdle(listener)
      return () => { physical(); logical(); guest() }
    },
    applySelection: (workspace, threadId, profile, commitSelection, assertCurrent) =>
      functions.reconfigureSelection(workspace, threadId, profile, commitSelection, assertCurrent),
    changed: threadId => {
      const owner = window()
      if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) {
        owner.webContents.send("mods:development-changed", { threadId })
        owner.webContents.send("mods:configuration-changed")
      }
    }
  })
  development.configureCompositionStatus(threadId => creatorComposition.status(threadId))
  development.configureCompositionSaveStatus(threadId => creatorComposition.saveStatus(threadId))
  setCreatorCompositionService(creatorComposition)
  const reuseThreads = new Set<string>()
  const creatorReuse = new CreatorReuseService({
    settings: manager.store, drafts: new AuthoringDraftStore(manager.store),
    claws: new ClawStore(manager.store), install: authoringInstall,
    readContext: threadId => {
      reuseThreads.delete(threadId)
      reuseThreads.add(threadId)
      if (reuseThreads.size > 64) reuseThreads.delete(reuseThreads.values().next().value!)
      return development.reuseContext(threadId)
    },
    readDraft: (threadId, id) => development.read(threadId, id),
    identity: threadId => {
      const scope = resolveClawThread(threadId, getThreadCore, workspace => manager.workspaceKey(workspace))
      if (!scope || scope.threadId !== threadId) throw Error("CREATOR_REUSE_SCOPE_CHANGED")
      return scope.identity
    },
    available: workspace => functions.status(workspace),
    stopTrial: async (scope, id, guard) => {
      guard()
      const trial = functions.developmentStatus(scope).find(item => item.draftId === id)
      if (!trial || trial.phase === "stopped") return
      await functions.stopDevelopment(scope, trial.componentId, guard)
      if (functions.developmentStatus(scope).some(item => item.draftId === id && item.phase !== "stopped"))
        throw Error("CREATOR_REUSE_STOP_UNCONFIRMED")
    },
    approveInstalled: (scope, receipt, guard) =>
      functions.approve(scope.workspace, receipt.installationId, receipt.compiledDigest, guard),
    applySelection: async (workspace, threadId, profile, commit, guard) => {
      const lease = claimConfigurationReload(threadId)
      if (!lease) throw Error("CREATOR_REUSE_BUSY")
      try {
        await functions.reconfigureSelection(workspace, threadId, profile, commit,
          () => { lease.assertLive(); guard() })
      } finally { lease.release() }
    },
    runtimeReady: (scope, profile) => functions.selectionRuntimeReady(scope.workspace, scope.threadId, profile),
    assertAuthorized: assertCreatorAuthorized,
    busy: () => {
      const runtime = functions.runtimeSessions()
      return listLocalThreadRunLeases().length > 0 || runtime.retiring > 0 || runtime.reserved > 0 ||
        runtime.sessions.some(session => functions.configurationBusy(session.threadId))
    },
    onIdle: listener => {
      const publish = () => { for (const id of reuseThreads) listener(id) }
      const physical = onLocalThreadRunLeaseReleased(publish)
      const logical = manager.functionTurns.onSettled(publish)
      const guest = functions.onConfigurationIdle(publish)
      return () => { physical(); logical(); guest() }
    },
    changed: threadId => {
      queueMicrotask(() => {
        void creatorComposition.reconcileSavedReuse(threadId).catch(() => {
          console.warn("[Mods] Named combination save needs reconciliation")
        })
      })
      const owner = window()
      if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) {
        owner.webContents.send("mods:development-changed", { threadId })
        owner.webContents.send("mods:configuration-changed")
      }
    }
  })
  development.configureReuse(creatorReuse)
  reconcileCreatorReuse = threadId => creatorReuse.reconcileAuthorizations(threadId)
  const trialUndo = new CreatorTrialUndoScheduler({
    read: scope => functions.developmentStatus(scope),
    stop: (scope, id, guard) => functions.stopDevelopment(scope, id, guard),
    busy: threadId => !!getLocalThreadRunLease(threadId) ||
      manager.functionTurns.hasUnsettled(threadId) || functions.configurationBusy(threadId),
    onIdle: listener => {
      const physical = onLocalThreadRunLeaseReleased(lease => listener(lease.threadId))
      const logical = manager.functionTurns.onSettled(listener)
      const guest = functions.onConfigurationIdle(listener)
      return () => { physical(); logical(); guest() }
    },
    changed: threadId => window()?.webContents.send("mods:development-changed", { threadId })
  })
  development.configureTrialUndoStop((scope, id, turnId, guard) => trialUndo.request(scope, id, turnId, guard))
  development.configureTrialUndoStatus(threadId => trialUndo.status(threadId))
  const readDeliveryPlugins = () => readProjectDeliveryInventory(
    getPluginsDir(), getInstalledPluginIds, getPlugins)
  const creatorBusiness = new CreatorBusinessService({
    root: join(getOpenworkDir(), "creator-business"), settings: manager.store,
    assembly: new BusinessModAssemblyService(join(getOpenworkDir(), "creator-business-assemblies"), {
      plugins: readDeliveryPlugins, validatePackage: inspectCompletePluginDirectory,
      install: installDerivedPluginDirectory,
      observeInstallation: (input, guard) => withPluginCatalogMutation(() =>
        observeProjectDeliveryInstallation(getPluginsDir(), readDeliveryPlugins, input, guard)),
      invalidate: () => { invalidateEnabledSkillsCache(); invalidatePluginHooksCache() }
    }),
    plugins: readDeliveryPlugins,
    normalizeWorkspace: workspace => manager.workspaceKey(workspace),
    context: threadId => development.projectAuthoringContext(threadId),
    readContext: threadId => development.reuseContext(threadId),
    busy: threadId => !!getLocalThreadRunLease(threadId) ||
      manager.functionTurns.hasUnsettled(threadId) || functions.configurationBusy(threadId),
    onIdle: listener => {
      const physical = onLocalThreadRunLeaseReleased(lease => listener(lease.threadId))
      const logical = manager.functionTurns.onSettled(listener)
      const guest = functions.onConfigurationIdle(listener)
      return () => { physical(); logical(); guest() }
    },
    changed: threadId => {
      const owner = window()
      if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed())
        owner.webContents.send("mods:development-changed", { threadId })
    }
  })
  const creatorBusinessTrials = new CreatorBusinessTrials({
    root: join(getOpenworkDir(), "creator-business", "trials"),
    settings: manager.store,
    context: threadId => development.reuseContext(threadId),
    busy: threadId => !!getLocalThreadRunLease(threadId) ||
      manager.functionTurns.hasUnsettled(threadId) || functions.configurationBusy(threadId),
    changed: threadId => {
      const owner = window()
      if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed())
        owner.webContents.send("mods:development-changed", { threadId })
    },
    candidate: (scope, candidate, guard) => creatorBusiness.trialCandidate(scope, candidate, guard),
    assertSources: sources => creatorBusiness.assertTrialSources(sources)
  })
  creatorBusiness.configureTrials(creatorBusinessTrials)
  const pluginStageRecoveries: PluginStageRecoverySessions = new PluginStageRecoverySessions({
    root: join(getOpenworkDir(), "creator-business", "trials"),
    settings: manager.store,
    owner: (scope, id) => creatorBusinessTrials.endedRecoveryOwner(scope, id),
    adoptedOwner: (scope, preparationId, targetId, evidenceDigest) =>
      creatorBusinessTrials.adoptedRecoveryOwner(scope, preparationId, targetId, evidenceDigest),
    adoptionStatus: (scope, preparationId, targetId, evidenceDigest) =>
      creatorBusinessTrials.adoptedRecoveryStatus(scope, preparationId, targetId, evidenceDigest),
    adopt: (owner, receipt) => creatorBusinessTrials.adoptRecoveredTrial(owner, receipt,
      () => pluginStageRecoveries.assertReceipt(receipt)),
    changed: threadId => {
      const owner = window()
      if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed())
        owner.webContents.send("mods:development-changed", { threadId })
    }
  })
  registerPluginStageRecoveryHandlers(ipcMain, pluginStageRecoveries, {
    trusted,
    normalizeWorkspace: workspace => manager.workspaceKey(workspace),
    context: threadId => development.reuseContext(threadId)
  })
  registerCreatorBusinessTrialHandlers(ipcMain, creatorBusiness, development, trusted, window)
  setCreatorBusinessService(creatorBusiness)
  development.configureBusinessStatus(threadId => {
    try { return creatorBusiness.status(threadId) } catch { return undefined }
  })
  const creatorProjectDeliveries = new CreatorProjectDeliveries({
    root: join(getOpenworkDir(), "creator-project-deliveries"),
    settings: manager.store,
    sessions: projectAuthoringSessions,
    context: threadId => development.reuseContext(threadId),
    occupied: threadId => !!getLocalThreadRunLease(threadId) ||
      manager.functionTurns.hasUnsettled(threadId) || functions.configurationBusy(threadId),
    plugins: readDeliveryPlugins,
    install: installDerivedPluginDirectory,
    normalizeWorkspace: workspace => manager.workspaceKey(workspace),
    observeInstallation: (input, guard) => withPluginCatalogMutation(() =>
      observeProjectDeliveryInstallation(getPluginsDir(), readDeliveryPlugins, input, guard)),
    invalidate: () => { invalidateEnabledSkillsCache(); invalidatePluginHooksCache() },
    changed: threadId => {
      const owner = window()
      if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed())
        owner.webContents.send("mods:development-changed", { threadId })
    }
  })
  development.configureProjectDeliveryStatus(threadId => {
    try { return creatorProjectDeliveries.status(threadId) } catch { return undefined }
  })
  const creatorSourceSets = new CreatorSourceSets({
    root: join(getOpenworkDir(), "creator-source-sets"), settings: manager.store,
    context: threadId => development.reuseContext(threadId),
    occupied: threadId => !!getLocalThreadRunLease(threadId) || manager.functionTurns.hasUnsettled(threadId) || functions.configurationBusy(threadId),
    sessions: projectAuthoringSessions, deliveries: creatorProjectDeliveries,
    plugins: readDeliveryPlugins, install: installDerivedPluginDirectory,
    validatePackage: inspectCompletePluginDirectory,
    functions: workspace => functions.status(workspace),
    assertAuthorized: (workspace, bindings) => {
      const plugins = readDeliveryPlugins()
      for (const binding of bindings) {
        const grant = manager.store.getGrant(workspace, `function:${binding.name}`)
        if (!grant?.enabled || grant.digest !== binding.digest ||
          !plugins.some(plugin => plugin.id === binding.pluginId && plugin.enabled !== false))
          throw Error("SOURCE_SET_AUTHORIZATION_CHANGED")
      }
    },
    observeInstallation: (input, guard) => withPluginCatalogMutation(() =>
      observeProjectDeliveryInstallation(getPluginsDir(), readDeliveryPlugins, input, guard)),
    invalidate: () => { invalidateEnabledSkillsCache(); invalidatePluginHooksCache() },
    changed: threadId => {
      const owner = window()
      if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed())
        owner.webContents.send("mods:development-changed", { threadId })
    }
  })
  development.configureSourceSetStatus(threadId => {
    try { return creatorSourceSets.status(threadId) } catch { return undefined }
  })
  registerModsDevelopmentHandlers(ipcMain, development, trusted, {
    importSourceSet: async input => {
      const context = development.reuseContext(input.threadId)
      if (context.scope.workspace !== manager.workspaceKey(input.expectedWorkspace)) throw Error("DEVELOPMENT_SCOPE_CHANGED")
      const owner = window()
      if (!owner || owner.isDestroyed()) throw Error("DEVELOPMENT_WINDOW_CHANGED")
      const result = await dialog.showOpenDialog(owner, { title: "选择含 devclaw.source-set.json 的作者源码目录", properties: ["openDirectory"] })
      context.assertCurrent()
      if (owner !== window() || owner.isDestroyed()) throw Error("DEVELOPMENT_WINDOW_CHANGED")
      if (!result.canceled && result.filePaths.length === 1)
        await creatorSourceSets.import(input.threadId, context.scope.workspace, result.filePaths[0])
      return development.status(input.threadId)
    },
    advanceSourceSet: async input => {
      await creatorSourceSets.advance(input.threadId, manager.workspaceKey(input.expectedWorkspace), input.id)
      return development.status(input.threadId)
    },
    cancelSourceSet: async input => {
      await creatorSourceSets.cancel(input.threadId, manager.workspaceKey(input.expectedWorkspace), input.id)
      return development.status(input.threadId)
    },
    installSourceSetDependency: async input => {
      await creatorSourceSets.install(input.threadId, manager.workspaceKey(input.expectedWorkspace), input.id, input.dependencyId)
      return development.status(input.threadId)
    },
    reconcileSourceSetDependency: async input => {
      await creatorSourceSets.reconcile(input.threadId, manager.workspaceKey(input.expectedWorkspace), input.id, input.dependencyId)
      return development.status(input.threadId)
    },
    approveModularization: async input => {
      await creatorBusiness.approveModularization(input.threadId, input.expectedWorkspace, input)
      return development.status(input.threadId)
    },
    prepareProjectDelivery: async input => {
      await creatorProjectDeliveries.prepare(input.threadId, input.expectedWorkspace, input)
      return development.status(input.threadId)
    },
    installProjectDelivery: async input => {
      await creatorProjectDeliveries.install(input.threadId, input.expectedWorkspace, input)
      return development.status(input.threadId)
    },
    reconcileProjectDelivery: async input => {
      await creatorProjectDeliveries.reconcile(input.threadId, input.expectedWorkspace, input)
      return development.status(input.threadId)
    },
    exportProjectDelivery: async input => {
      const context = development.reuseContext(input.threadId)
      if (context.scope.workspace !== manager.workspaceKey(input.expectedWorkspace)) throw Error("DEVELOPMENT_SCOPE_CHANGED")
      const candidate = creatorProjectDeliveries.status(input.threadId)
      if (candidate?.id !== input.deliveryId || candidate.digest !== input.digest || !candidate.canExport)
        throw Error("PROJECT_DELIVERY_REVIEW_REQUIRED")
      const owner = window()
      if (!owner || owner.isDestroyed()) throw Error("DEVELOPMENT_WINDOW_CHANGED")
      const result = await dialog.showSaveDialog(owner, { title: "保存为新的插件 ZIP",
        defaultPath: `${candidate.name}-${candidate.version}.zip`,
        filters: [{ name: "插件 ZIP", extensions: ["zip"] }] })
      context.assertCurrent()
      if (owner !== window() || owner.isDestroyed()) throw Error("DEVELOPMENT_WINDOW_CHANGED")
      if (!result.canceled && result.filePath)
        await creatorProjectDeliveries.export(input.threadId, input.expectedWorkspace, input, result.filePath)
      return development.status(input.threadId)
    },
    reconcileBusiness: async input => {
      await creatorBusiness.reconcile(input.threadId, input.expectedWorkspace, input)
      return development.status(input.threadId)
    },
    approveBusiness: async input => {
      await creatorBusiness.approve(input.threadId, input.expectedWorkspace, input)
      return development.status(input.threadId)
    },
    exportBusiness: async input => {
      const context = development.reuseContext(input.threadId)
      if (context.scope.workspace !== manager.workspaceKey(input.expectedWorkspace)) throw Error("DEVELOPMENT_SCOPE_CHANGED")
      const owner = window()
      if (!owner || owner.isDestroyed()) throw Error("DEVELOPMENT_WINDOW_CHANGED")
      const result = await dialog.showSaveDialog(owner, {
        title: "导出独立业务插件", defaultPath: "my-business-plugin.zip",
        filters: [{ name: "插件 ZIP", extensions: ["zip"] }]
      })
      context.assertCurrent()
      if (owner !== window() || owner.isDestroyed()) throw Error("DEVELOPMENT_WINDOW_CHANGED")
      if (!result.canceled && result.filePath)
        await creatorBusiness.exportTrusted(input.threadId, input.expectedWorkspace, input, result.filePath)
      return development.status(input.threadId)
    },
    undoComposition: async input => {
      await creatorComposition.undo(input.threadId, input.expectedWorkspace)
      return development.status(input.threadId)
    },
    cancelComposition: input => {
      creatorComposition.cancel(input.threadId, input.expectedWorkspace)
      return development.status(input.threadId)
    },
    undoTrial: async input => {
      const context = development.reuseContext(input.threadId)
      if (context.scope.workspace !== input.expectedWorkspace) throw Error("DEVELOPMENT_SCOPE_CHANGED")
      const runId = `creator-undo:${randomUUID()}`
      const claim = claimLocalThreadRunLease({ threadId: input.threadId, owner: "mods", runId })
      if (!claim.acquired) throw Error("DEVELOPMENT_BUSY")
      const owns = captureLocalThreadRunLease(input.threadId)!
      let completed = false
      try {
        await development.undoTrial(input.threadId, runId, new AbortController().signal, () => {
          context.assertCurrent()
          if (!owns()) throw Error("DEVELOPMENT_TURN_CHANGED")
        })
        completed = true
      } finally {
        // This is the trusted native undo operation's settlement, never a fabricated model turn.
        publishDevelopmentTurnSettlement({ threadId: input.threadId, turnId: runId,
          incarnation: context.scope.incarnation, outcome: completed ? "completed" : "cancelled" })
        releaseLocalThreadRunLease(input.threadId, "mods", runId)
      }
      return development.status(input.threadId)
    }
  })
  const evaluationFlows = registerModsFlowHandlers(ipcMain, manager, functions, {
    trusted,
    threadScope: writableThreadScope,
    changed: (threadId) => {
      const owner = window()
      if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed())
        owner.webContents.send("mods:flow-changed", { threadId })
    }
  })
  configureWorkflowDeterministicActions({
    functions,
    store: manager.store.functionState,
    workspaceKey: workspace => manager.workspaceKey(workspace),
    thread: getThreadCore,
    runOwned: (scope, work) => runPlatformUserAction(queue, manager, scope.workspace,
      scope.threadId, scope.signal, scope.assertCurrent, work)
  })
  setProjectRuntimeFunctions(functions, workspace => manager.workspaceKey(workspace), {
    settingsStamp: workspace => JSON.stringify(["enabled", "policy", "epoch"].map(key =>
      manager.store.getSetting(`${key}:${workspace}`, ""))),
    globallyEnabled: () => manager.isGloballyEnabled(),
    enabled: workspace => manager.isEnabled(workspace),
    enable: workspace => manager.configure(workspace, true, manager.protects(workspace))
  })
  const projectInputs = createHostProjectInputIdentity(functions, {
    contextDataRoot: join(getOpenworkDir(), "plugin-data"),
    rules: (workspace, names) => ({ managed: manager.policy.digest,
      completion: names.map(name => [name, new ApplicationCompletionPolicies(manager.store).value(workspace, name) ?? null]) })
  })
  setProjectActionRuntime(normalizeProjectActionRuntime({ flows: evaluationFlows,
    ...projectInputs,
    captureOperationRetirement: (workspace, threadId) =>
      manager.captureFunctionThreadRetirement(threadId, workspace),
    verifyReadOnlyContextProvider: (workspace, threadId, provider, signal) =>
      functions.verifyReadOnlyContextProvider(workspace, threadId, provider, signal),
    verifyReadOnlyCheckProvider: (workspace, threadId, provider, signal) =>
      functions.verifyReadOnlyCheckProvider(workspace, threadId, provider, signal),
    publishRequiredContext: (workspace, text, signal) => manager.publish(workspace, text, undefined, signal),
    readRuns: (workspace, threadId) => new FlowStore(manager.store).runs(workspace, threadId),
    readActionResult: (workspace, threadId, runId, executionId) =>
      new FlowStore(manager.store).actionResult(workspace, threadId, runId, executionId),
    catalog: (workspace, threadId) => functions.actionCatalog(workspace, threadId),
    prepareSelection: (workspace, threadId, bindings) => prepareProjectActionSelection(
      workspace, threadId, bindings, {
        store: new ClawStore(manager.store),
        catalog: (key, id) => functions.actionCatalog(key, id),
        closeThread: (id) => manager.closeFunctionThread(id),
        assertScope: () => {
          const thread = getThreadCore(threadId)
          const metadata = typeof thread?.metadata === "string"
            ? JSON.parse(thread.metadata) : thread?.metadata
          if (!metadata?.hostProjectRuntime ||
              projectActionFlowMetadata(threadId, metadata) === metadata ||
              writableThreadScope(threadId) !== workspace || !manager.isEnabled(workspace))
            throw Error("PROJECT_ACTION_SCOPE_CHANGED")
          const selected = functionClawScope(threadId)
          if (!selected || selected.threadId !== threadId) throw Error("PROJECT_ACTION_SCOPE_CHANGED")
          return selected.identity
        }
      }
    ) }, workspace => manager.workspaceKey(workspace)))
  registerLegacyModsRuntime(createLegacyModsRuntime({ store: manager.store,
    workspaceKey: workspace => manager.workspaceKey(workspace),
    isEnabled: workspace => manager.isEnabled(workspace), plugins: getPlugins }))
  const evaluationRunner = createEvaluationRunner(evaluationFlows, manager.store)
  const evaluationAccess = {
    trusted,
    threadScope: writableThreadScope,
    captureThreadFence: (threadId: string) => {
      const thread = getThreadCore(threadId)
      if (!thread) throw Error("STALE")
      const incarnation = captureThreadIncarnation(thread)
      return () => { if (!matchesThreadIncarnation(getThreadCore(threadId), incarnation)) throw Error("STALE") }
    }
  }
  registerEvaluationHandlers(ipcMain, evaluationRunner, evaluationAccess)
  registerSkillEvaluationHandlers(ipcMain, createSkillEvaluationService(manager.store, evaluationRunner, () => {
    for (const owner of BrowserWindow.getAllWindows()) {
      if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send("skills:changed")
    }
  }), evaluationAccess)
  const stopPlatformFileEdits = registerPlatformFileEditSink({
    capture: (workspace, threadId) => {
      const currentWorkspace = writableThreadScope(threadId)
      if (manager.workspaceKey(workspace) !== currentWorkspace) return undefined
      const incarnation = captureThreadIncarnation(getThreadCore(threadId)!)
      return {
        workspace: currentWorkspace, threadId, incarnation: JSON.stringify(incarnation),
        assertCurrent: () => {
          if (writableThreadScope(threadId) !== currentWorkspace ||
            !matchesThreadIncarnation(getThreadCore(threadId), incarnation))
            throw new ModFunctionError("MODS_PLATFORM_TARGET_CHANGED")
        }
      }
    },
    publish: (facts) => functions.publishHostFileEdit(facts)
  })
  manager.attachFunctions({
    appendConversation: (...args) => functions.appendConversation(...args),
    independentModelPrompt: (...args) => functions.independentModelPrompt(...args),
    hasEventHandler: (...args) => functions.hasEventHandler(...args),
    clawDefaultModel: (workspace, threadId) => functions.clawDefaultModel(workspace, threadId),
    clawProfile: (workspace, threadId) => functions.clawSelection(workspace, threadId),
    runtimeReady: (...args) => functions.runtimeReady(...args),
    registeredAgent: (...args) => functions.registeredAgent(...args),
    receivePeer: (...args) => functions.receivePeer(...args),
    completionGate: (...args) => functions.completionGate(...args),
    turnStart: (...args) => functions.turnStart(...args),
    turnComplete: (...args) => functions.turnComplete(...args),
    measure: (...args) => functions.measure(...args),
    hasToolCheck: (workspace, threadId) => functions.hasToolCheck(workspace, threadId),
    toolCheck: (binding, input, core, origin) =>
      functions.interceptToolCheck(
        binding.workspace,
        binding.threadId,
        input,
        binding.signal,
        core,
        origin
      ),
    registeredTools: (workspace, threadId) => functions.registeredTools(workspace, threadId),
    toolCall: (binding, input, core) =>
      withFunctionExecution(
        {
          runtimeAuthority: binding.runtimeAuthority,
          workspace: binding.workspace,
          threadId: binding.threadId,
          agentId: binding.agentId,
          turnId: binding.turnId,
          userInitiated: false,
          leased: true,
          immediate: false
        },
        () =>
          functions.interceptTool(binding.workspace, binding.threadId, input, binding.signal, core,
            manager.functionModelHookSource(binding.runtimeAuthority))
      ),
    turnStep: (...args) => functions.turnStep(...args),
    offerAgent: (...args) => functions.offerAgent(...args),
    classicEvent: (...args) => functions.classicEvent(...args),
    presentationEvent: (...args) => functions.presentationEvent(...args),
    invalidate: (workspace) => functions.invalidate(workspace),
    pluginsChanged: (workspace, ids) => functions.pluginsChanged(workspace, ids),
    invalidateAll: () => functions.invalidateAll(),
    prepareEnd: (reason, threadId) => functions.prepareEnd(reason, threadId),
    closeThread: (threadId) => {
      if (!getThreadCore(threadId)) functions.forgetReleasedThread(threadId)
      functions.closeThread(threadId)
      queue.closeThread(threadId)
    },
    closeThreadAndWait: async (threadId) => {
      if (!getThreadCore(threadId)) functions.forgetReleasedThread(threadId)
      queue.closeThread(threadId)
      await functions.closeThreadAndWait(threadId)
    },
    captureThreadRetirement: (threadId) => {
      const captured = functions.captureThreadRetirement(threadId)
      return { ...captured, retire: async () => {
        captured.assertCurrent()
        queue.closeThread(threadId)
        await captured.retire()
      } }
    },
    captureIdleThreadRetirement: (workspace, threadId) => {
      const captured = functions.captureIdleThreadRetirement(workspace, threadId)
      return { ...captured, retire: async (beforeRetire?: () => void) => {
        captured.assertCurrent()
        await captured.retire(() => {
          captured.assertCurrent()
          beforeRetire?.()
          queue.closeThread(threadId)
        })
      } }
    },
    close: () => { functions.close(); desktopBroker.close(); promptBroker.close() }
  })
  app.once("will-quit", () => {
    stopPlatformFileEdits()
    stopPolicyObservations()
    setModDevelopmentService(undefined)
    creatorComposition.close()
    pluginStageRecoveries.close()
    creatorBusiness.close()
    setCreatorBusinessService(undefined)
    setCreatorUserConfigService(undefined)
    configureExtensionContextDirectoryBinding(undefined)
    creatorReuse.close()
    reconcileCreatorReuse = undefined
    trialUndo.close()
    setCreatorCompositionService(undefined)
    queue.close()
    setModsManager(undefined)
    manager.close()
  })
  manager.onFunctionPeerMessagesChanged((_workspace, threadId) => {
    const owner = window()
    if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed())
      owner.webContents.send("mods:peer-messages-changed", { threadId })
  })
  ipcMain.handle("mods:peer-messages", (event, data: unknown) => {
    if (
      !data ||
      typeof data !== "object" ||
      !("threadId" in data) ||
      typeof data.threadId !== "string" ||
      !data.threadId
    )
      throw new ModError("MODS_IPC_ARGUMENTS")
    return manager.listFunctionPeerMessages(scope(event, data.threadId), data.threadId)
  })

  function trusted(event: IpcMainInvokeEvent): void {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    const packagedUrl = pathToFileURL(join(__dirname, "../renderer/index.html")).href
    const owner = window()
    if (
      !owner ||
      owner.webContents !== event.sender ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new ModError("MODS_IPC_SENDER")
    }
    const url = new URL(event.senderFrame.url)
    if (
      rendererUrl
        ? url.origin !== new URL(rendererUrl).origin
        : url.href.split(/[?#]/)[0] !== packagedUrl
    ) {
      throw new ModError("MODS_IPC_ORIGIN")
    }
  }
  function scope(event: IpcMainInvokeEvent, threadId: string): string {
    trusted(event)
    return threadScope(threadId)
  }
  function settingsScope(event: IpcMainInvokeEvent, threadId: string,
    expectedWorkspace?: string, writable = false) {
    const read = () => writable ? writableScope(event, threadId) : scope(event, threadId)
    const workspace = read()
    if (expectedWorkspace !== undefined &&
      (typeof expectedWorkspace !== "string" || expectedWorkspace !== workspace))
      throw new ModError("MODS_SCOPE_CHANGED")
    const incarnation = expectedWorkspace === undefined ? undefined :
      captureThreadIncarnation(getThreadCore(threadId)!)
    const frame = event.sender?.mainFrame
    return { workspace, assertCurrent: () => {
      if (read() !== workspace || (incarnation !== undefined &&
        (event.sender.mainFrame !== frame ||
          !matchesThreadIncarnation(getThreadCore(threadId), incarnation))))
        throw new ModError("MODS_SCOPE_CHANGED")
    } }
  }
  function threadScope(threadId: string): string {
    const workspace = readThreadWorkspacePath(threadId)
    return manager.workspaceKey(workspace)
  }
  function readThreadWorkspacePath(threadId: string): string {
    if (typeof threadId !== "string" || threadId.length > 200)
      throw new ModError("MODS_THREAD_INVALID")
    const { thread } = readNativeChildModsThread(threadId, getThreadRuntimeScope)
    if (!thread) throw new ModError("MODS_THREAD_MISSING")
    const metadata =
      typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
    if (typeof metadata?.workspacePath !== "string") throw new ModError("MODS_WORKSPACE_REQUIRED")
    return metadata.workspacePath
  }
  async function withDisplayExecution<T>(event: IpcMainInvokeEvent, threadId: string,
    run: (workspace: string) => Promise<T>): Promise<T> {
    const workspace = scope(event, threadId)
    const row = getThreadCore(threadId)
    if (!row) throw new ModError("MODS_THREAD_MISSING")
    const incarnation = captureThreadIncarnation(row)
    const nativeFrame = event.sender.mainFrame
    const markdownFrame = captureFunctionMarkdownFrame(event.sender)
    // Check existing receipts before creating a native display entry; expired is never cold.
    const execution = functionExecutionScope(workspace, threadId)
    const parentAuthority = functionCallAuthority(workspace, threadId)
    const parentAgent = functionCallAgent(workspace, threadId)
    const parentTurn = functionCallTurn(workspace, threadId)
    const hasParent = execution !== undefined || parentAuthority !== undefined ||
      parentTurn !== undefined || parentAgent !== "main"
    const facts = hasParent
      ? { runtimeAuthority: parentAuthority, agentId: parentAgent, turnId: parentTurn }
      : manager.functionUserScope(workspace, threadId)
    // A cold main-window display owns no turn, human intent or file-write lease.
    const agentId = facts.agentId ?? "main"
    const assertDisplay = () => {
      markdownFrame.assertCurrent()
      if (event.sender.mainFrame !== nativeFrame || scope(event, threadId) !== workspace ||
        !matchesThreadIncarnation(getThreadCore(threadId), incarnation))
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
      facts.runtimeAuthority?.assertLive()
    }
    assertDisplay()
    return withFunctionTransportExecution({ workspace, threadId, agentId,
      turnId: facts.turnId, runtimeAuthority: facts.runtimeAuthority,
      userInitiated: false, leased: false, immediate: true }, () =>
      withFunctionMarkdownDisplay({ epoch: markdownFrame.epoch, assertCurrent: assertDisplay }, async () => {
      const value = await run(workspace)
      assertDisplay()
      return value
    }))
  }
  function writableScope(event: IpcMainInvokeEvent, threadId: string): string {
    trusted(event)
    return writableThreadScope(threadId)
  }
  function writableThreadScope(threadId: string): string {
    const workspace = threadScope(threadId)
    const { thread } = readNativeChildModsThread(threadId, getThreadRuntimeScope)
    if (!thread) throw new ModError("MODS_THREAD_MISSING")
    const metadata =
      typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
    if (
      metadata?.remoteState === "historical" ||
      (metadata?.targetKind === "inbox" && metadata?.remoteReadOnly === true)
    )
      throw new ModError("MODS_THREAD_READ_ONLY")
    return workspace
  }
  // A native worker association supplies data identity, never parent execution permission.
  function assertFunctionDataScope(workspace: string, threadId: string): void {
    const worker = readNativeChildModsContext(threadId)
    const current = writableThreadScope(worker?.parentThreadId ?? threadId)
    if (current !== workspace ||
      (worker && manager.workspaceKey(worker.workspace) !== current))
      throw new ModError("MODS_CALL_SCOPE_CHANGED")
    worker?.assertCurrent()
  }
  function functionClawScope(threadId: string): { threadId: string; identity: string } | null {
    const worker = readNativeChildModsContext(threadId)
    if (worker) assertFunctionDataScope(manager.workspaceKey(worker.workspace), threadId)
    const selected = resolveClawThread(worker?.parentThreadId ?? threadId,
      getThreadRuntimeScope, (workspace) => manager.workspaceKey(workspace))
    return worker && selected ? { threadId, identity: selected.identity } : selected
  }
  function functionCapabilityContext(workspace: string, threadId: string) {
    const worker = readNativeChildModsContext(threadId)
    if (worker) assertFunctionDataScope(manager.workspaceKey(worker.workspace), threadId)
    return resolveCapabilityContext(workspace, worker?.parentThreadId ?? threadId, {
      thread: getThreadRuntimeScope,
      projectWorkspaces: getHarnessCapabilityWorkspaces,
      featureWorkspace: getHarnessCapabilityFeatureWorkspace,
      hostProject: (id, root, binding) => {
        return readBuiltinProjectBinding(id, root, (binding as { projectId?: string }).projectId)
      }
    })
  }
  function assertStandaloneThread(threadId: string): void {
    const thread = getThreadCore(threadId)!
    const metadata =
      typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
    if (
      resolveAgentModeFromMetadata(metadata) !== "normal" ||
      metadata?.harnessProjectId ||
      metadata?.featureId ||
      metadata?.workflowRunId ||
      metadata?.parentThreadId
    )
      throw new ModError("MODS_THREAD_CONTEXT_REQUIRED")
  }
  registerClawHandlers(ipcMain, manager, functions, {
    context: functionCapabilityContext,
    sources: async () => {
      const [{ listClawSkillSources }, { readClawMcpSources }] = await Promise.all([
        import("../mods/claw-skills"),
        import("../mods/claw-mcp")
      ])
      return { skills: await listClawSkillSources(), mcp: readClawMcpSources() }
    },
    scope: writableScope,
    applicable: (threadId) => isClawThread(threadId, getThreadCore, (workspace) => manager.workspaceKey(workspace)),
    identity: (threadId) => {
      const scope = resolveClawThread(threadId, getThreadCore, (workspace) => manager.workspaceKey(workspace))
      if (!scope || scope.threadId !== threadId) throw Error("CLAW_SCOPE_INVALID")
      return scope.identity
    },
    validateModels: async (refs) => {
      const { getModelConfigByRef } = await import("../models/registry")
      for (const ref of refs)
        if (!getModelConfigByRef(ref)?.apiKey) throw Error(`CLAW_MODEL_UNAVAILABLE: ${ref}`)
    },
    assertIdle: (_workspace, threadId) => {
      for (const lease of listLocalThreadRunLeases()) {
        if (lease.threadId === threadId)
          throw Error("本对话有任务或审批正在进行，请结束或取消后再应用 Claw 组合。")
      }
    },
    changed: () => {
      creatorComposition.reconcile()
      creatorReuse.reconcileAuthorizations()
      window()?.webContents.send("mods:configuration-changed")
    }
  })
  ipcMain.handle("mods:commands", async (event, threadId: string) => {
    const workspace = scope(event, threadId)
    return [
      ...(await manager.commands(workspace, threadId)),
      ...(await withDisplayExecution<ModCommandDescriptor[]>(event, threadId,
        current => functions.commands(current, threadId)))
    ]
  })
  ipcMain.handle("mods:function-logs", (event, threadId: string) =>
    functions.logs(scope(event, threadId), threadId)
  )
  ipcMain.handle("mods:function-feedback", (event, threadId: string) =>
    functions.feedback(scope(event, threadId), threadId)
  )
  ipcMain.handle("mods:desktop-feedback", (event, input: { threadId: string; owner: string }) => {
    const workspace = writableScope(event, input?.threadId)
    return desktopBroker.feedback(event.sender.id, input.threadId, input.owner,
      () => functions.feedbackPresentation(workspace, input.threadId))
  })
  ipcMain.handle("mods:desktop-present", (event, report: import("../../shared/mods/v2/presentation").FunctionPresentationReport) => {
    writableScope(event, report?.threadId)
    desktopBroker.present(event.sender.id, report)
  })
  ipcMain.handle("mods:function-turn-notices", (event, threadId: string) =>
    functions.turnNotices(scope(event, threadId), threadId)
  )
  registerPlatformHandlers(ipcMain, functions, {
    capture: (event, threadId, writable) => {
      const read = () => writable ? writableScope(event, threadId) : scope(event, threadId)
      const workspace = read(), frame = event.sender.mainFrame
      const incarnation = captureThreadIncarnation(getThreadCore(threadId)!)
      return {
        workspace,
        assertCurrent: () => {
          if (read() !== workspace || event.sender.mainFrame !== frame ||
            !matchesThreadIncarnation(getThreadCore(threadId), incarnation))
            throw new ModFunctionError("MODS_PLATFORM_SCOPE_CHANGED")
        }
      }
    },
    view: (workspace, threadId, work) => withFunctionExecution({
      ...manager.functionUserScope(workspace, threadId), workspace, threadId,
      leased: false, immediate: false, userInitiated: true
    }, work),
    userAction: (workspace, threadId, signal, guard, work) =>
      runPlatformUserAction(queue, manager, workspace, threadId, signal, guard, work)
  })
  registerRuntimeSessionHandlers(ipcMain, functions, trusted, (event, threadId, writable) => {
    const read = () => writable ? writableScope(event, threadId) : scope(event, threadId)
    const workspace = read(), frame = event.sender.mainFrame
    const thread = getThreadCore(threadId)!
    const incarnation = captureThreadIncarnation(thread)
    return { workspace, incarnationKey: JSON.stringify(incarnation),
      ...(typeof thread.title === "string" ? { title: thread.title.trim().slice(0, 200) } : {}),
      assertCurrent: () => {
      if (read() !== workspace || event.sender.mainFrame !== frame ||
        !matchesThreadIncarnation(getThreadCore(threadId), incarnation))
        throw new ModFunctionError("MODS_RUNTIME_SESSION_STALE")
    } }
  })
  registerFunctionConfigHandlers(ipcMain, functions, writableScope, async (event, kind) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) throw new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED")
    const result = await dialog.showOpenDialog(window, {
      title: kind === "directory" ? "选择插件使用的目录" : "选择插件使用的文件",
      properties: [kind === "directory" ? "openDirectory" : "openFile"]
    })
    return result.canceled ? undefined : result.filePaths[0]
  }, async (event, view) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || owner.isDestroyed() || !view.migration?.canApply)
      throw new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED")
    const result = await dialog.showMessageBox(owner, {
      type: "warning", title: "确认迁移插件配置",
      message: `将 ${view.plugin} 的配置从版本 ${view.migration.fromVersion} 迁移到 ${view.migration.toVersion}`,
      detail: "字段删除可能移除敏感配置。重命名的密钥只在本机重新加密，不会向助手或插件包公开。失败时保留原配置。\n\n" +
        (view.migration.changes.map(change => change.kind === "rename"
          ? `重命名：${change.from} → ${change.to}` : `删除保存值：${change.key}`).join("\n") || "保留兼容的已有保存值，采用新版字段约束和默认值。"),
      buttons: ["取消", "确认迁移配置"], defaultId: 0, cancelId: 0, noLink: true
    })
    return result.response === 1
  }, (event, threadId) =>
    settingsScope(event, threadId, writableScope(event, threadId), true).assertCurrent)
  ipcMain.handle("mods:function-completion-evidence", (event, threadId: string) =>
    functions.completionEvidence(scope(event, threadId), threadId)
  )
  ipcMain.handle(
    "mods:function-checkpoint-inspect",
    (event, input: { threadId: string; recordId: string }) =>
      functions.inspectCheckpointRecovery(
        scope(event, input?.threadId),
        input.threadId,
        input.recordId
      )
  )
  ipcMain.handle(
    "mods:function-completion-policy",
    (event, input: { threadId: string; plugin: string; expectedWorkspace?: string }) =>
      functions.completionPolicy(settingsScope(event, input?.threadId,
        input?.expectedWorkspace).workspace, input.threadId, input.plugin)
  )
  ipcMain.handle("mods:function-autobiz-environment", async (event,
    input: string | { threadId: string; expectedWorkspace?: string }) => {
    const threadId = typeof input === "string" ? input : input?.threadId
    const access = settingsScope(event, threadId,
      typeof input === "string" ? undefined : input?.expectedWorkspace)
    const autobizEnvironment = await inspectAutobizEnvironment()
    access.assertCurrent()
    return autobizEnvironment
  })
  ipcMain.handle(
    "mods:function-completion-policy-set",
    (event, input: { threadId: string; plugin: string; policy: unknown;
      expectedWorkspace?: string }) => {
      const { workspace } = settingsScope(event, input?.threadId, input?.expectedWorkspace, true)
      const result = functions.setCompletionPolicy(
        workspace,
        input.threadId,
        input.plugin,
        input.policy
      )
      const owner = window()
      if (owner && !owner.isDestroyed()) owner.webContents.send("mods:configuration-changed")
      return result
    }
  )
  ipcMain.handle(
    "mods:function-autobiz-transition",
    (event, input: { threadId: string; transition: ModObject }) => {
      const workspace = writableScope(event, input?.threadId)
      return withFunctionExecution(
        {
          ...manager.functionUserScope(workspace, input.threadId),
          workspace,
          threadId: input.threadId,
          leased: false,
          immediate: false,
          userInitiated: true
        },
        () =>
          functions.advanceAutobizCheckpoint(
            workspace,
            input.threadId,
            parseModJson(encodeModJson(input.transition)) as ModObject,
            new AbortController().signal
          )
      )
    }
  )
  ipcMain.handle(
    "mods:function-focus-ack",
    (
      event,
      input: {
        threadId: string
        ack: import("../../shared/mods/v2/ui-focus").FunctionFocusAck
      }
    ) =>
      functions.focusAck(
        writableScope(event, input?.threadId),
        input.threadId,
        parseModJson(
          encodeModJson(input.ack)
        ) as unknown as import("../../shared/mods/v2/ui-focus").FunctionFocusAck
      )
  )
  ipcMain.handle(
    "mods:function-scroll-ack",
    (
      event,
      input: {
        threadId: string
        ack: import("../../shared/mods/v2/ui-scroll").FunctionScrollAck
      }
    ) =>
      functions.scrollAck(
        writableScope(event, input?.threadId),
        input.threadId,
        parseModJson(
          encodeModJson(input.ack)
        ) as unknown as import("../../shared/mods/v2/ui-scroll").FunctionScrollAck
      )
  )
  ipcMain.handle("mods:function-panes", (event, threadId: string) =>
    withDisplayExecution(event, threadId, workspace => functions.panes(workspace, threadId))
  )
  ipcMain.handle("mods:function-markdown-link", (event, input: unknown) => {
    const { threadId, action } = functionMarkdownIpcLink(input)
    const workspace = scope(event, threadId)
    const incarnation = captureThreadIncarnation(getThreadCore(threadId)!)
    const frame = event.sender.mainFrame
    const markdownFrame = captureFunctionMarkdownFrame(event.sender)
    const assertSender = () => {
      markdownFrame.assertCurrent()
      if (event.sender.mainFrame !== frame || scope(event, threadId) !== workspace ||
        !matchesThreadIncarnation(getThreadCore(threadId), incarnation))
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    return withDisplayExecution(event, threadId, () => functions.markdownLink(
      workspace, threadId, action, assertSender,
      async (href, assertCurrent, session) => {
        assertCurrent()
        if (functionMarkdownUrlTransform(href) !== href)
          throw new ModError("MODS_UI_MARKDOWN_ACTION_INVALID")
        if (/^https?:/i.test(href)) {
          await shell.openExternal(href)
          assertCurrent()
          return { state: "opened" }
        }
        const runtime = manager.functionRuntimeScope(workspace, threadId)
        const files = runtime.bound
          ? runtime.queryTool ? { ...runtime, queryTool: runtime.queryTool }
            : (() => { throw new ModError("MODS_FS_CONTEXT_REQUIRED") })()
          : await createComposerPermissionScope(runtime.workspace, threadId, () => {
              runtime.assertLive(); assertCurrent()
            }, session.lifecycleSignal, manager.clawProfile(workspace, threadId)?.skills)
        assertCurrent()
        const preview = await session.markdownPreviews.read(href, files, assertCurrent,
          (value, signal) => manager.publish(workspace, value, undefined, signal),
          session.lifecycleSignal)
        assertCurrent()
        return { state: "preview", preview }
      },
      run => {
        assertSender()
        if (writableScope(event, threadId) !== workspace) throw new ModError("MODS_CALL_SCOPE_CHANGED")
        return withFunctionExecution({ ...manager.functionUserScope(workspace, threadId),
          workspace, threadId, leased: false, immediate: false, userInitiated: true }, run)
      }
    ))
  })
  ipcMain.handle("mods:function-markdown-preview", (event, input: unknown) => {
    const { threadId, receipt } = functionMarkdownIpcReceipt(input)
    const workspace = scope(event, threadId)
    return functions.markdownPreview(workspace, threadId, receipt)
  })
  ipcMain.handle("mods:function-markdown-preview-close", (event, input: unknown) => {
    const { threadId, receipt } = functionMarkdownIpcReceipt(input)
    functions.markdownPreviewClose(scope(event, threadId), threadId, receipt)
  })
  ipcMain.handle(
    "mods:function-site-mount",
    (
      event,
      input: {
        threadId: string
        component: import("../../shared/mods/v2/sites").FunctionUiSite
        messageId?: string
      }
    ) => withDisplayExecution(event, input?.threadId, workspace =>
      functions.siteMount(workspace, input.threadId, input.component, input.messageId))
  )
  ipcMain.handle(
    "mods:function-site-mount-outcome",
    (event, input: {
      threadId: string
      component: import("../../shared/mods/v2/sites").FunctionUiSite
      messageId?: string
      expectedRequestId?: string
    }) => withDisplayExecution(event, input?.threadId, workspace =>
      functions.siteMountOutcome(workspace, input.threadId, input.component,
        input.messageId, input.expectedRequestId))
  )
  ipcMain.handle(
    "mods:function-site-render",
    (
      event,
      input: {
        threadId: string
        owner: string
        props: ModObject
      }
    ) => withDisplayExecution(event, input?.threadId, workspace =>
      functions.siteRender(
        workspace,
        input.threadId,
        input.owner,
        parseModJson(encodeModJson(input.props)) as ModObject
      )
    )
  )
  ipcMain.handle("mods:function-site-read", (event, input: {
    threadId: string
    component: import("../../shared/mods/v2/sites").FunctionUiSite
    props: ModObject
    presentationId?: string
    messageId?: string
    expectedRequestId?: string
    protocol?: unknown
    ownerRequired?: boolean
  }) => withDisplayExecution(event, input?.threadId, workspace =>
    functions.siteRead(workspace, input.threadId, input.component,
      parseModJson(encodeModJson(input.props)) as ModObject, input.presentationId,
      input.messageId, input.expectedRequestId, input.protocol, input.ownerRequired === true)))
  ipcMain.handle(
    "mods:function-site-unmount",
    (event, input: { threadId: string; owner: string }) =>
      functions.siteUnmount(scope(event, input?.threadId), input.threadId, input.owner)
  )
  ipcMain.handle(
    "mods:function-site-act",
    (
      event,
      input: {
        threadId: string
        owner: string
        action: FunctionUiAction
      }
    ) => {
      const workspace = writableScope(event, input?.threadId)
      return withFunctionExecution(
        {
          ...manager.functionUserScope(workspace, input.threadId),
          workspace,
          threadId: input.threadId,
          leased: false,
          immediate: false,
          userInitiated: ["press", "submit", "select"].includes(input.action?.kind)
        },
        () =>
          functions.siteAct(
            workspace,
            input.threadId,
            input.owner,
            parseModJson(encodeModJson(input.action)) as unknown as FunctionUiAction
          )
      )
    }
  )
  ipcMain.handle(
    "mods:function-client-act",
    (event, input: { threadId: string; action: FunctionClientAction }) => {
      const workspace = writableScope(event, input?.threadId)
      return withFunctionExecution(
        {
          ...manager.functionUserScope(workspace, input.threadId),
          workspace,
          threadId: input.threadId,
          leased: false,
          immediate: false,
          userInitiated: ["press", "submit", "select", "key"].includes(input.action?.kind)
        },
        () =>
          functions.clientAct(
            workspace,
            input.threadId,
            parseModJson(encodeModJson(input.action)) as unknown as FunctionClientAction
          )
      )
    }
  )
  ipcMain.handle(
    "mods:function-ui-act",
    (event, input: { threadId: string; action: FunctionUiAction }) => {
      const workspace = writableScope(event, input?.threadId)
      return withFunctionExecution(
        {
          ...manager.functionUserScope(workspace, input.threadId),
          workspace,
          threadId: input.threadId,
          leased: false,
          immediate: false,
          userInitiated: true
        },
        () =>
          functions.act(
            workspace,
            input.threadId,
            parseModJson(encodeModJson(input.action)) as unknown as FunctionUiAction
          )
      )
    }
  )
  ipcMain.handle("mods:artifact", (event, input: { threadId: string; id: string }) => {
    const workspace = scope(event, input?.threadId)
    if (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id))
      throw new ModError("MODS_ARTIFACT_ID")
    return manager.artifact(workspace, input.threadId, input.id)
  })
  ipcMain.handle("mods:save-artifact", async (event, input: { threadId: string; id: string }) => {
    const workspace = scope(event, input?.threadId)
    if (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id))
      throw new ModError("MODS_ARTIFACT_ID")
    const owner = window()!
    await manager.artifact(workspace, input.threadId, input.id)
    const choice = await dialog.showSaveDialog(owner, {
      title: "导出检查后的文本产物",
      defaultPath: "mod-result.txt",
      filters: [{ name: "Text", extensions: ["txt"] }]
    })
    if (choice.canceled || !choice.filePath) return false
    const content = await manager.artifact(workspace, input.threadId, input.id)
    await writeFile(choice.filePath, content.text, { encoding: "utf8", flag: "wx" })
    return true
  })
  ipcMain.handle(
    "mods:enqueue",
    async (
      event,
      input: { threadId: string; descriptor: ModCommandDescriptor; args: ModObject }
    ) => {
      const workspace = writableScope(event, input?.threadId)
      if (!manager.isEnabled(workspace)) throw new ModError("MODS_DISABLED")
      if (input.descriptor?.apiVersion === "cmb.mods/v2") {
        const executionScope = manager.functionUserScope(workspace, input.threadId)
        if (!input.args || typeof input.args.text !== "string" || input.args.text.length > 32000)
          throw new ModError("MODS_COMMAND_ARGS")
        const descriptor = (await withDisplayExecution<ModCommandDescriptor[]>(event,
          input.threadId, current => functions.commands(current, input.threadId))).find(
          (entry) => entry.command === input.descriptor.command
        )
        if (
          !descriptor ||
          descriptor.digest !== input.descriptor.digest ||
          descriptor.grantEpoch !== input.descriptor.grantEpoch ||
          descriptor.workspaceEpoch !== input.descriptor.workspaceEpoch ||
          descriptor.modId !== input.descriptor.modId
        )
          throw new ModError("MODS_COMMAND_STALE")
        const text = input.args.text
        return queue.enqueue(
          workspace,
          input.threadId,
          descriptor.command,
          async (signal) => {
            if (writableScope(event, input.threadId) !== workspace)
              throw new ModError("MODS_CALL_SCOPE_CHANGED")
            return withFunctionExecution(
              {
                ...executionScope,
                workspace,
                threadId: input.threadId,
                leased: !descriptor.immediate,
                immediate: descriptor.immediate === true,
                userInitiated: true
              },
              () => functions.runCommand(workspace, input.threadId, descriptor, text, signal)
            )
          },
          { immediate: descriptor.immediate === true, inlineResult: true }
        ).job
      }
      const args = parseModJson(encodeModJson(input.args))
      if (
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        encodeModJson(args).length > 16_000
      )
        throw new ModError("MODS_COMMAND_ARGS")
      const candidate = (await manager.commands(workspace, input.threadId)).find(
        (entry) => entry.command === input.descriptor?.command
      )
      if (
        !candidate ||
        candidate.digest !== input.descriptor.digest ||
        candidate.grantEpoch !== input.descriptor.grantEpoch ||
        candidate.workspaceEpoch !== input.descriptor.workspaceEpoch ||
        candidate.turnId !== input.descriptor.turnId
      )
        throw new ModError("MODS_COMMAND_STALE")
      return queue.enqueue(workspace, input.threadId, candidate.command, async (signal) => {
        if (writableScope(event, input.threadId) !== workspace)
          throw new ModError("MODS_CALL_SCOPE_CHANGED")
        let cleanup: (() => Promise<void>) | undefined
        if (manager.needsCommandBinding(input.threadId)) {
          const thread = getThreadCore(input.threadId)!
          const metadata =
            typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
          if (
            resolveAgentModeFromMetadata(metadata) !== "normal" ||
            metadata?.harnessProjectId ||
            metadata?.featureId ||
            metadata?.workflowRunId ||
            metadata?.parentThreadId
          )
            throw new ModError("MODS_THREAD_CONTEXT_REQUIRED")
          cleanup = await bindStandaloneModCommand(
            workspace,
            input.threadId,
            candidate.turnId,
            signal
          )
        }
        try {
          return await manager.runCommand(
            workspace,
            input.threadId,
            candidate,
            args as ModObject,
            signal
          )
        } finally {
          await cleanup?.()
        }
      }).job
    }
  )
  ipcMain.handle("mods:jobs", async (event, threadId: string) => {
    const workspace = scope(event, threadId)
    const jobs = manager.store.jobs(threadId).filter((job) => job.workspace === workspace)
    for (const job of jobs)
      if (job.result) job.result = await manager.publish(workspace, job.result)
    return jobs
  })
  ipcMain.handle("mods:cancel-job", (event, input: { threadId: string; id: string }) => {
    writableScope(event, input?.threadId)
    if (typeof input.id !== "string") throw new ModError("MODS_JOB_UNAVAILABLE")
    queue.cancel(input.threadId, input.id)
  })
  ipcMain.handle("mods:status", async (event, threadId: string) => {
    const workspace = scope(event, threadId)
    return { ...(await manager.status(workspace)), functionMods: await functions.status(workspace) }
  })
  ipcMain.handle("mods:composer-enabled", (event, threadId: string) => {
    trusted(event)
    const workspace = readThreadWorkspacePath(threadId)
    const canonicalWorkspace = manager.workspaceKey(workspace)
    return { workspace, enabled: manager.isEnabled(canonicalWorkspace) }
  })
  ipcMain.handle(
    "mods:check-function-compatibility",
    async (event, input: { threadId: string; pluginId: string; digest: string;
      expectedWorkspace?: string }) => {
      const access = settingsScope(event, input?.threadId, input?.expectedWorkspace)
      const { workspace } = access
      if (
        !input ||
        typeof input.pluginId !== "string" ||
        !input.pluginId ||
        input.pluginId.length > 256 ||
        typeof input.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.digest)
      )
        throw new ModError("MODS_GRANT_INVALID")
      const result = await functions.checkCompatibility(workspace, input.pluginId, input.digest)
      access.assertCurrent()
      return result
    }
  )
  ipcMain.handle("mods:chat-display-capability", (event,
    input: { threadId: string; expectedWorkspace: string }) => {
    trusted(event)
    if (!input || typeof input.expectedWorkspace !== "string" || !input.expectedWorkspace.trim())
      throw new ModError("MODS_SCOPE_CHANGED")
    const expectedWorkspace = manager.workspaceKey(input.expectedWorkspace)
    return readModsChatDisplayCapability(manager,
      settingsScope(event, input.threadId, expectedWorkspace))
  })
  ipcMain.handle("mods:builtin-catalog", (event) => {
    trusted(event)
    return describeDevClawBuiltins({
      "devclaw-project-instructions": "available", "devclaw-policy": "available",
      "devclaw-change-review": "available",
      "devclaw-observability": "available", "devclaw-extension-authoring": "available",
      "devclaw-project-advisor": "available"
    })
  })
  registerBuiltinAdvisorHandlers(ipcMain, manager, {
    scope: (event, threadId, expectedWorkspace) => settingsScope(event, threadId, expectedWorkspace, true)
  })
  ipcMain.handle("mods:builtin-overview", (event,
    input: { threadId: string; expectedWorkspace: string }) => {
    trusted(event)
    if (!input || typeof input.expectedWorkspace !== "string" || !input.expectedWorkspace.trim())
      throw new ModError("MODS_SCOPE_CHANGED")
    const access = settingsScope(event, input.threadId, manager.workspaceKey(input.expectedWorkspace))
    const row = getThreadCore(input.threadId)!
    const records = manager.store.audit(access.workspace, 101, Number.MAX_SAFE_INTEGER, input.threadId)
    const result = projectBuiltinRunOverview({
      threadId: input.threadId, workspace: access.workspace, capturedAt: Date.now(),
      instructions: builtinInstructionsStore.read({ threadId: input.threadId, workspace: access.workspace,
        incarnationKey: JSON.stringify(captureThreadIncarnation(row)) }),
      records: records.slice(0, 100), limited: records.length > 100,
      policy: manager.policy.deployment
    })
    result.project = readBuiltinProjectFacts(input.threadId, access.workspace).facts
    const observationScope = { threadId: input.threadId, workspace: access.workspace,
      incarnationKey: JSON.stringify(captureThreadIncarnation(row)) }
    result.policy.decisions = readBuiltinPolicyDecisions(observationScope, records.slice(0, 100))
    result.legacyMetrics = readBuiltinLegacyMetrics(observationScope)
    access.assertCurrent()
    return result
  })
  ipcMain.handle("mods:builtin-change-review", async (event,
    input: { threadId: string; expectedWorkspace: string;
      baseline: import("../../shared/mods/builtin-change-review").BuiltinChangeReviewBaseline }) => {
    trusted(event)
    if (!input || typeof input.expectedWorkspace !== "string" || !input.expectedWorkspace.trim() ||
      !["head", "task", "stage", "project"].includes(input.baseline)) throw new ModError("MODS_SCOPE_CHANGED")
    const access = settingsScope(event, input.threadId, manager.workspaceKey(input.expectedWorkspace))
    const incarnationKey = JSON.stringify(captureThreadIncarnation(getThreadCore(input.threadId)!))
    const identity = { threadId: input.threadId, workspace: access.workspace, incarnationKey }
    const runId = builtinInstructionsStore.read(identity).snapshot?.runId ?? "unobserved"
    const result = await builtinChangeReviewService.read({ ...identity, runId }, input.baseline)
    access.assertCurrent()
    // A new turn can begin while Git is being read without changing the thread incarnation.
    if ((builtinInstructionsStore.read(identity).snapshot?.runId ?? "unobserved") !== runId)
      throw new ModError("MODS_SCOPE_CHANGED")
    return result
  })
  ipcMain.handle("mods:global-enabled", (event) => {
    trusted(event)
    return getModsGlobalEnabled()
  })
  ipcMain.handle("mods:configure-global", (event, enabled: boolean) => {
    trusted(event)
    if (typeof enabled !== "boolean") throw new ModError("MODS_SETTINGS_INVALID")
    const value = setModsGlobalEnabled(enabled)
    manager.invalidateAll()
    creatorComposition.reconcile()
    creatorReuse.reconcileAuthorizations()
    const owner = window()
    if (owner && !owner.isDestroyed()) owner.webContents.send("mods:configuration-changed")
    return value
  })
  ipcMain.handle("mods:function-unlocked", (event) => {
    trusted(event)
    return true // Compatibility with older renderers; settings no longer require a password.
  })
  ipcMain.handle("mods:unlock-function", (event) => {
    trusted(event)
    return true
  })
  ipcMain.handle(
    "mods:approve-function",
    async (event, input: { threadId: string; pluginId: string; digest: string;
      expectedWorkspace?: string }) => {
      const workspace = scope(event, input?.threadId)
      if (typeof input.pluginId !== "string" || !/^[a-f0-9]{64}$/.test(input.digest))
        throw new ModError("MODS_GRANT_INVALID")
      if (input.expectedWorkspace !== undefined) {
        if (typeof input.expectedWorkspace !== "string" || input.expectedWorkspace !== workspace)
          throw new ModError("MODS_APPROVAL_SCOPE_CHANGED")
        const threadId = input.threadId
        const incarnation = captureThreadIncarnation(getThreadCore(threadId)!)
        const frame = event.sender.mainFrame
        const assertCurrent = () => {
          if (event.sender.mainFrame !== frame || scope(event, threadId) !== workspace ||
            !matchesThreadIncarnation(getThreadCore(threadId), incarnation))
            throw new ModError("MODS_APPROVAL_SCOPE_CHANGED")
        }
        await functions.approve(workspace, input.pluginId, input.digest, assertCurrent)
      } else {
        await functions.approve(workspace, input.pluginId, input.digest)
      }
      const owner = window()
      if (owner && !owner.isDestroyed()) owner.webContents.send("mods:configuration-changed")
    }
  )
  ipcMain.handle("mods:revoke-function", (event, input: { threadId: string; name: string;
    expectedWorkspace?: string }) => {
    const { workspace } = settingsScope(event, input?.threadId, input?.expectedWorkspace)
    if (typeof input.name !== "string" || input.name.length > 100)
      throw new ModError("MODS_GRANT_INVALID")
    functions.revoke(workspace, input.name)
    creatorComposition.reconcile()
    creatorReuse.reconcileAuthorizations()
    const owner = window()
    if (owner && !owner.isDestroyed()) owner.webContents.send("mods:configuration-changed")
  })
  ipcMain.handle(
    "mods:configure",
    (event, input: { threadId: string; enabled: boolean; outputPolicy: boolean;
      expectedWorkspace?: string }) => {
      const { workspace } = settingsScope(event, input?.threadId, input?.expectedWorkspace)
      if (typeof input.enabled !== "boolean" || typeof input.outputPolicy !== "boolean")
        throw new ModError("MODS_SETTINGS_INVALID")
      manager.configure(workspace, input.enabled, input.outputPolicy)
      const owner = window()
      if (owner && !owner.isDestroyed()) owner.webContents.send("mods:configuration-changed")
      creatorComposition.reconcile()
      creatorReuse.reconcileAuthorizations()
    }
  )
  ipcMain.handle(
    "mods:approve",
    (event, input: { threadId: string; pluginId: string; digest: string;
      expectedWorkspace?: string }) => {
      const access = settingsScope(event, input?.threadId, input?.expectedWorkspace)
      const { workspace } = access
      if (typeof input.pluginId !== "string" || !/^[a-f0-9]{64}$/.test(input.digest))
        throw new ModError("MODS_GRANT_INVALID")
      return manager.approve(workspace, input.pluginId, input.digest, access.assertCurrent)
    }
  )
  ipcMain.handle("mods:revoke", (event, input: { threadId: string; modId: string;
    expectedWorkspace?: string }) => {
    const { workspace } = settingsScope(event, input?.threadId, input?.expectedWorkspace)
    if (typeof input.modId !== "string") throw new ModError("MODS_GRANT_INVALID")
    manager.revoke(workspace, input.modId)
  })
  ipcMain.handle("mods:cards", (event, input: { threadId: string; callId: string }) => {
    const workspace = scope(event, input?.threadId)
    if (typeof input.callId !== "string") throw new ModError("MODS_CALL_INVALID")
    return manager.publishedCards(workspace, input.threadId, input.callId, event.sender.id)
  })
  ipcMain.handle("mods:audit", (event, input: { threadId: string; before?: number;
    expectedWorkspace?: string }) =>
    manager.store.audit(settingsScope(event, input?.threadId, input?.expectedWorkspace).workspace,
      50, input.before)
  )
  ipcMain.handle(
    "mods:reconcile",
    async (
      event,
      input: {
        threadId: string
        callId: string
        resolution: "confirmed-success" | "confirmed-failure"
        expectedWorkspace?: string
      }
    ) => {
      const access = settingsScope(event, input?.threadId, input?.expectedWorkspace)
      const { workspace } = access
      const owner = window()
      if (!owner) throw new ModError("MODS_IPC_SENDER")
      if (
        typeof input.callId !== "string" ||
        !["confirmed-success", "confirmed-failure"].includes(input.resolution)
      )
        throw new ModError("MODS_RECONCILIATION_INVALID")
      const result = await dialog.showMessageBox(owner, {
        type: "question",
        title: "核查未知操作",
        message: "已在外部系统核实这次操作的结果？",
        detail: `调用 ${input.callId}\n记录为${input.resolution === "confirmed-success" ? "已成功" : "未成功"}。这里只记录核查结论，不会重新执行操作。`,
        buttons: ["取消", "记录核查结论"],
        defaultId: 0,
        cancelId: 0
      })
      access.assertCurrent()
      if (result.response === 1) manager.store.reconcile(workspace, input.callId, input.resolution)
    }
  )
  ipcMain.handle("mods:backup", async (event) => {
    trusted(event)
    const owner = window()
    if (!owner) throw new ModError("MODS_IPC_SENDER")
    const result = await dialog.showSaveDialog(owner, {
      title: "备份 Mods 授权与执行记录",
      defaultPath: `mods-control-${Date.now()}.sqlite`,
      filters: [{ name: "SQLite", extensions: ["sqlite"] }]
    })
    if (result.canceled || !result.filePath) return false
    manager.store.backup(result.filePath)
    return true
  })
  ipcMain.handle("mods:act", (event, input: { threadId: string; actionId: string }) => {
    const workspace = writableScope(event, input?.threadId)
    if (typeof input.actionId !== "string") throw new ModError("MODS_ACTION_INVALID")
    return queue.enqueue(workspace, input.threadId, "卡片操作", (signal) => {
      if (writableScope(event, input.threadId) !== workspace)
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
      return manager.act(event.sender.id, input.threadId, input.actionId, signal)
    }).completion
  })
  registerCommunityExampleHandlers(ipcMain, bundledCommunityExamplesRoot(__dirname), trusted)
  ipcMain.handle("mods:install-examples", async (event) => {
    trusted(event)
    for (const name of ["project-quality", "company-output-policy", "function-commands"]) {
      const result = await installPluginFromDir(
        join(bundledModExamplesRoot(__dirname), name),
        name,
        "local"
      )
      if (!result.success) throw new ModError("MODS_EXAMPLE_INSTALL_FAILED")
    }
  })
}
