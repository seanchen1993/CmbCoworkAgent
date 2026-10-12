import { readBotComputerHelp } from "../../shared/bot-computer-help"
import { BOT_SINGLE_BOT_ROOM_CAPABILITY } from "../../shared/bot-groups"
import { BOT_EVENT_STATE_CAPABILITY } from "../../shared/bot-event-state"
import { BOT_PEER_FILES_CAPABILITY } from "../../shared/bot-peer-files"
import { BOT_SKILL_MAINTENANCE_CAPABILITY } from "../../shared/bot-skill-maintenance"
import { BOT_USER_SKILLS_CAPABILITY } from "../../shared/bot-skill-library"
import { BOT_ROUTINE_DISPATCH_CAPABILITY } from "../../shared/bot-routine-dispatch"
import { readBotRoutineDispatchHistory } from "./routine-dispatch-history"
import { botComputerHelpCompletion } from "./computer-help-completion"
import { botMemorySaveInput, botMemoryDeleteInput } from "../../shared/bot-memory"
import { guardBotRpcMutationEpoch } from "./rpc-mutation-epoch"
import { serializeBotFailure } from "./error-diagnostic"
import { botEntityCandidateRequest } from "../../shared/bot-entity-references"
import { parseBotEntitySelections } from "./entity-references"
import { listBotAsyncTasks } from "./async-tasks"
import { createServer, type Server, type Socket } from "node:net"
import { BOT_MAX_ROUTINES } from "../../shared/bot-routines"
import { BOT_WORK_PAGES_CAPABILITY } from "../../shared/bot-work-pages"
import { timingSafeEqual } from "node:crypto"
import { BOT_PROTOCOL_VERSION, BotDomainError } from "../../shared/bot-types"
import type { CoworkBotAPI } from "../../shared/bot-api"
import { BotHost } from "./host"
import * as v from "./validation"
import { readBotSecretCard } from "../../shared/bot-secrets"
import { BotSearch } from "./search"
import { botSkillSelection } from "../../shared/bot-skill-references"
import type { BotComputerClient } from "./computer-client"
import {
  botNativeDesktopTarget,
  botNativeDesktopHumanInput,
  botNativeDesktopSecretPreparation,
  botNativeDesktopSecretSubmission,
  type BotNativeDesktopTarget
} from "../../shared/bot-native-desktop"
import {
  botPluginPaneAction,
  botPluginSessionKey,
  isBotPluginPresentationAction
} from "../../shared/bot-plugin-panes"

export const BOT_RPC_MAX_BYTES = 8 * 1024 * 1024
export const BOT_RPC_MAX_PENDING = 8

export function createBotAPI(
  host: BotHost,
  client: BotComputerClient = new AbortController().signal
): CoworkBotAPI {
  const store = host.store
  const search = new BotSearch(store)
  const computer = async (botId: string, taskRunId?: string, mutate = false) => {
    if (taskRunId) store.taskBrowsers.assertOwner(botId, taskRunId, mutate)
    store.getBot(botId)
    if (!host.computer) throw new BotDomainError("computer_unavailable", "电脑服务未配置")
    const broker =
      taskRunId && !mutate && !store.taskBrowsers.active(taskRunId)
        ? await host.computer.existing()
        : await host.computer.get()
    if (!broker)
      throw new BotDomainError("workflow_browser_released", "任务浏览器已释放，执行记录仍可查看")
    store.getBot(botId)
    if (taskRunId) store.taskBrowsers.assertOwner(botId, taskRunId, mutate)
    return broker
  }
  const computerAddress = (input: Parameters<CoworkBotAPI["computerOpen"]>[0]) =>
    typeof input === "string"
      ? { botId: v.identifier(input), taskRunId: undefined }
      : store.taskBrowsers.resolve(input)
  const nativeComputer = (
    target: Pick<BotNativeDesktopTarget, "botId" | "taskRunId">,
    mutate = false
  ) => {
    client.throwIfAborted()
    store.getBot(v.identifier(target.botId))
    if (target.taskRunId) store.taskBrowsers.assertOwner(target.botId, target.taskRunId, mutate)
    host.assertComputerSupervision()
    if (!host.nativeComputer)
      throw new BotDomainError("computer_unavailable", "此后台未配置原生应用电脑")
    return host.nativeComputer
  }
  return {
    async nativeComputerOpen(address) {
      const owner = computerAddress(address)
      const broker = nativeComputer(owner)
      if (owner.taskRunId && !store.taskBrowsers.active(owner.taskRunId))
        broker.target(owner.botId, owner.taskRunId)
      else await broker.ensure(owner.botId, owner.taskRunId)
      nativeComputer(owner)
      return broker.clientTarget(owner.botId, client, owner.taskRunId)
    },
    async nativeComputerWindows(raw) {
      const target = botNativeDesktopTarget.parse(raw)
      const broker = nativeComputer(target)
      return broker.windows(
        target,
        () => {
          nativeComputer(target)
        },
        client
      )
    },
    async nativeComputerSelect(raw) {
      const input = v.record(raw)
      const target = botNativeDesktopTarget.parse(input.target)
      const viewId = v.identifier(input.viewId)
      const broker = nativeComputer(target, true)
      broker.assertHumanClient(target.botId, client, target.taskRunId)
      return broker.selectWindow(
        target,
        viewId,
        () => {
          nativeComputer(target, true)
          broker.assertHumanClient(target.botId, client, target.taskRunId)
        },
        client
      )
    },
    async nativeComputerObserve(raw) {
      const target = botNativeDesktopTarget.parse(raw)
      const broker = nativeComputer(target)
      broker.assertHumanClient(target.botId, client, target.taskRunId)
      return broker.observe(
        target,
        () => {
          nativeComputer(target)
          broker.assertHumanClient(target.botId, client, target.taskRunId)
        },
        client
      )
    },
    async nativeComputerPrepareSecret(raw) {
      const parsed = botNativeDesktopSecretPreparation.safeParse(raw)
      if (!parsed.success)
        throw new BotDomainError("native_secret_invalid", "安全输入目标无效，请重新选择")
      const { target, elementId } = parsed.data
      const broker = nativeComputer(target, true)
      broker.assertHumanClient(target.botId, client, target.taskRunId)
      try {
        return await broker.prepareHumanSecret(target, elementId, client)
      } catch {
        throw new BotDomainError(
          "native_secret_unavailable",
          "当前密码控件无法安全填入，请重新选择"
        )
      }
    },
    async nativeComputerProvideSecret(raw) {
      const parsed = botNativeDesktopSecretSubmission.safeParse(raw)
      if (!parsed.success)
        throw new BotDomainError("native_secret_invalid", "安全输入无效，请重新输入")
      const { target, token, value } = parsed.data
      try {
        const broker = nativeComputer(target, true)
        broker.assertHumanClient(target.botId, client, target.taskRunId)
        // Teach source/service locks precede broker serialization. No broker operation
        // waits for the service queue, and concurrent resume cannot capture this input.
        const release = await host.teach?.pauseForNativeSecret(target.botId, client)
        try {
          nativeComputer(target, true)
          await broker.fillHumanSecret(target, token, value, client)
        } finally {
          release?.()
        }
      } catch (error) {
        const code = error instanceof BotDomainError ? error.code : "native_secret_failed"
        const safe = {
          computer_owned_elsewhere: "此电脑由另一客户端接管，请先转移控制权",
          stale_target: "密码目标或控制权已变化，请重新选择",
          native_secret_unconfirmed: "安全输入结果尚未确认，请核对应用；不会自动重试"
        }
        if (Object.hasOwn(safe, code))
          throw new BotDomainError(code, safe[code as keyof typeof safe])
        throw new BotDomainError("native_secret_failed", "安全输入未完成，请重新观察密码控件")
      }
    },
    async nativeComputerFrame(address) {
      const owner = computerAddress(address)
      const broker = nativeComputer(owner)
      if (owner.taskRunId && !store.taskBrowsers.active(owner.taskRunId))
        broker.target(owner.botId, owner.taskRunId)
      return broker.frame(owner.botId, client, owner.taskRunId)
    },
    async nativeComputerTake(raw) {
      const input = v.record(raw)
      if (input.replaceHuman !== undefined && typeof input.replaceHuman !== "boolean")
        throw new Error("Invalid native control transfer")
      const target = botNativeDesktopTarget.parse(input.target)
      return nativeComputer(target, true).takeControl(target, client, input.replaceHuman === true)
    },
    async nativeComputerRelease(raw) {
      const target = botNativeDesktopTarget.parse(raw)
      return nativeComputer(target, true).releaseControl(target, client)
    },
    async nativeComputerInput(raw) {
      const input = v.record(raw)
      const target = botNativeDesktopTarget.parse(input.target)
      return nativeComputer(target, true).humanInput(
        target,
        botNativeDesktopHumanInput.parse(input.input),
        client
      )
    },
    async usageBudget(input) {
      return store.usageBudgets.view(input)
    },
    async changeUsageBudget(input) {
      return store.usageBudgets.change(input)
    },
    pluginPanes: (input) => host.pluginPanes(input),
    async pluginPaneAction(raw) {
      const input = botPluginPaneAction.parse(raw)
      // Configuration validation precedes the queue transaction. The origin is
      // checked again synchronously inside it, after any intervening UI update.
      const address = {
        botId: input.botId,
        conversationId: input.conversationId,
        threadRootId: input.threadRootId
      }
      let unavailable: unknown
      try {
        const view = await host.pluginPanes(address)
        if (view.sessionId !== input.sessionId || !host.functionSessions)
          throw new BotDomainError("plugin_pane_stale", "面板已关闭或后台已重启，请重新打开面板")
      } catch (error) {
        unavailable = error
      }
      if (isBotPluginPresentationAction(input)) {
        if (unavailable) throw unavailable
        const messageId = await host.functionSessions!.presentationInput(
          botPluginSessionKey(input),
          input
        )
        return { messageId, runIds: [] }
      }
      const result = store.pluginPaneActions.submit(input, (value) => {
        // Recover an already accepted receipt even after the session expired.
        if (unavailable)
          throw new BotDomainError(
            "plugin_pane_stale",
            "面板已更新或暂不可用，请在当前面板重新操作"
          )
        try {
          return host.functionSessions!.actionOrigin(botPluginSessionKey(value), value)
        } catch {
          throw new BotDomainError("plugin_pane_stale", "面板已更新，请在当前面板重新操作")
        }
      })
      host.tick()
      return result
    },
    async changeNotifications(input) {
      return store.notifications.change(input)
    },
    async avatar(input) {
      return store.avatars.read(input)
    },
    async changeAvatar(input) {
      return store.avatars.change(input, client, host.mediaReader)
    },
    async thread(input) {
      return store.threads.get(input)
    },
    async threadSummaries(input) {
      return store.threads.summaries(input)
    },
    async search(input) {
      return search.search(input)
    },
    async referenceCandidates(input) {
      const request = botEntityCandidateRequest.parse(input)
      return store.entityReferences.catalog(
        request,
        !request.kind || request.kind === "connector" ? await host.connectors() : []
      )
    },
    async skillCandidates(input) {
      await host.refreshSkills()
      return store.skillReferences.catalog(input)
    },
    async react(input) {
      return store.reactions.setUser(input)
    },
    async reactions(input) {
      return store.reactions.readMany(input)
    },
    async secrets(botId) {
      if (!host.secretRequests) throw new Error("凭据服务未就绪")
      return host.secretRequests.vault.list(botId)
    },
    async saveSecret(input) {
      if (!host.secretRequests) throw new Error("凭据服务未就绪")
      return host.secretRequests.vault.save(input)
    },
    async deleteSecret(input) {
      if (!host.secretRequests) throw new Error("凭据服务未就绪")
      return host.secretRequests.vault.remove(input)
    },
    async provideSecret(input) {
      if (!host.secretRequests) throw new Error("安全输入服务未就绪")
      host.secretRequests.provide(input)
      host.tick()
    },
    async filePreview(input) {
      if (!host.files) throw new Error("文件服务未就绪")
      return host.files.previews.read(input)
    },
    async cancelFilePreview(input) {
      if (!host.files) throw new Error("文件服务未就绪")
      host.files.previews.cancel(input)
    },
    async beginUpload(input) {
      if (!host.files) throw new Error("文件服务未就绪")
      return host.files.transfers.begin(input)
    },
    async uploadChunk(input) {
      if (!host.files) throw new Error("文件服务未就绪")
      return host.files.transfers.chunk(input)
    },
    async finishUpload(id) {
      if (!host.files) throw new Error("文件服务未就绪")
      return host.files.transfers.finish(id)
    },
    async cancelUpload(id) {
      if (!host.files) throw new Error("文件服务未就绪")
      return host.files.transfers.cancel(id)
    },
    async fileChunk(input) {
      if (!host.files) throw new Error("文件服务未就绪")
      return host.files.chunk(input)
    },
    async teachHistory(input) {
      if (!host.teach) throw new Error("示范服务未就绪")
      return host.teach.repository.history(input)
    },
    async teachVideoChunk(input) {
      if (!host.teach) throw new Error("示范服务未就绪")
      return host.teach.videoChunk(input)
    },
    async teachDelete(input) {
      if (!host.teach) throw new Error("示范服务未就绪")
      return host.teach.deleteRecording(input)
    },
    connectors: () => host.connectors(),
    async checkModel(input) {
      if (!host.modelChecks)
        throw new BotDomainError("model_check_unavailable", "此后台不支持模型检查，请更新应用")
      return host.modelChecks.check(input, client)
    },
    async cancelModelCheck(input) {
      if (!host.modelChecks)
        throw new BotDomainError("model_check_unavailable", "此后台不支持模型检查，请更新应用")
      host.modelChecks.cancel(input, client)
    },
    async backupSchedule() {
      return (
        host.backups?.view() ?? {
          ...store.backupSchedule.read(),
          dataEpoch: store.backupSchedule.epoch(),
          running: false,
          available: false
        }
      )
    },
    async changeBackupSchedule(input) {
      if (!host.backups) throw new Error("定时备份服务未就绪")
      const state = store.backupSchedule.change(input)
      void host.backups.tick()
      return state
    },
    async teachRetry(input) {
      if (!host.teach) throw new Error("示范服务未就绪")
      const result = host.teach.repository.retry(input)
      host.tick()
      return result
    },
    async skillDependencies(input) {
      const selection = botSkillSelection.parse(input)
      if (selection.id.startsWith("desktop:")) await host.refreshSkills()
      return host.skillDependencies(selection)
    },
    async checkSkillDependencies(input) {
      if (!host.commandExecutionAvailable)
        throw new BotDomainError(
          "shell_unavailable",
          "当前后台不提供可执行依赖检查；原检查记录仍可查看。"
        )
      await host.refreshSkills()
      const receipt = store.skillDependencies.submit(input)
      host.tick()
      return receipt
    },
    async skillTrials(botId) {
      return store.skillTrials(botId)
    },
    async trialSkill(input) {
      const trial = store.trialSkill(input)
      host.tick()
      return trial
    },
    async reviewSkillTrial(input) {
      return store.reviewSkillTrial(input)
    },
    async teachStatus(botId) {
      store.getBot(botId)
      return host.teach?.status(botId) ?? null
    },
    async teachStart(input) {
      if (!host.teach) throw new Error("示范服务未就绪")
      return host.teach.start(input, client)
    },
    async teachPause(input) {
      if (!host.teach) throw new Error("示范服务未就绪")
      return host.teach.pause(input, client)
    },
    async teachStop(input) {
      if (!host.teach) throw new Error("示范服务未就绪")
      const result = await host.teach.stop(input, client)
      host.tick()
      return result
    },
    async emitEvent(input) {
      const result = store.emitEvent(input)
      host.tick()
      return result
    },
    async webhook(input) {
      if (!host.webhooks) throw new Error("Webhook 服务未就绪")
      return host.webhooks.view(input)
    },
    async changeWebhook(input) {
      if (!host.webhooks) throw new Error("Webhook 服务未就绪")
      return store.webhooks.change(input)
    },
    async restartWebhook(input) {
      if (!host.webhooks) throw new Error("Webhook 服务未就绪")
      host.webhooks.view(input) // Validate the requested scope before touching the listener.
      await host.webhooks.start()
      return host.webhooks.view(input)
    },
    async runRoutine(input) {
      const run = store.runRoutine(input)
      host.tick()
      return run
    },
    async artifacts(id) {
      return store.artifacts(id)
    },
    async deleteFile(input) {
      if (!host.files) throw new Error("文件服务未就绪")
      return host.files.remove(input)
    },
    async upload(input) {
      if (!host.files) throw new Error("文件服务未就绪")
      return host.files.upload(input)
    },
    async download(id) {
      if (!host.files) throw new Error("文件服务未就绪")
      const value = await host.files.read(id)
      return {
        artifact: value.artifact,
        base64: value.bytes.toString("base64")
      }
    },
    async peerExchange(input) {
      return store.peerExchanges.read(input)
    },
    async runHistory(input) {
      return store.runHistory(input)
    },
    async worktreeDetail(input) {
      if (!host.worktrees) throw new Error("工作区服务未就绪")
      return host.worktrees.detail(store, input, client)
    },
    async worktreeMerge(input) {
      if (!host.worktrees) throw new Error("工作区服务未就绪")
      return host.worktrees.merge(store, input, client)
    },
    async worktreeCleanup(input) {
      if (!host.worktrees) throw new Error("工作区服务未就绪")
      return host.worktrees.cleanup(store, input, client)
    },
    async workflowControl(input) {
      const result = store.controlWorkflowChild(input)
      host.tick()
      return result
    },
    async effectDetail(input) {
      return store.effectDetail(input)
    },
    async interactionDetail(input) {
      return store.interactionDetail(input)
    },
    async effects(id) {
      return store.effects(id)
    },
    async recover(input) {
      const run = store.recover(input)
      host.tick()
      return run
    },
    async localToolPermission() {
      return store.localTools.read()
    },
    async changeLocalToolPermission(input) {
      store.localTools.assertPublicTarget(input)
      const result = store.localTools.change(input)
      store.localTools.assertPublicTarget(input)
      return result
    },
    async resolveLocalToolPermission(input) {
      store.localTools.assertPublicTarget(input)
      const result = store.localTools.resolve(input)
      store.localTools.assertPublicTarget(input)
      return result
    },
    async computerOpen(id) {
      const owner = computerAddress(id)
      const broker = await computer(owner.botId, owner.taskRunId)
      computerAddress(id)
      await broker.ensure(owner.botId, owner.taskRunId)
      computerAddress(id)
      return broker.clientTarget(owner.botId, client, owner.taskRunId)
    },
    async computerFrame(id) {
      const owner = computerAddress(id)
      const broker = await computer(owner.botId, owner.taskRunId)
      computerAddress(id)
      const frame = await broker.frame(owner.botId, client, owner.taskRunId)
      computerAddress(id)
      return frame
    },
    async computerTake(target) {
      v.record(target)
      const task =
        target.taskRunId === undefined ? undefined : store.getRun(v.identifier(target.taskRunId))
      const conversationId =
        target.conversationId === undefined ? undefined : v.identifier(target.conversationId)
      if (conversationId && !store.getConversation(conversationId).members.includes(target.botId))
        throw new BotDomainError("invalid_recipient", "Bot 不属于该对话")
      const threadRootId =
        target.threadRootId === undefined ? undefined : v.identifier(target.threadRootId)
      if (threadRootId !== undefined) {
        if (!conversationId) throw new BotDomainError("thread_unavailable", "分支需要指定所属对话")
        store.threads.root(conversationId, threadRootId)
      }
      const replaceHuman =
        target.replaceHuman === undefined ? false : v.boolean(target.replaceHuman, "转移控制权")
      if (task)
        store.assertRunAddress({
          runId: task.id,
          conversationId: conversationId ?? task.conversationId,
          threadRootId: threadRootId ?? task.threadRootId
        })
      return (await computer(target.botId, target.taskRunId, true)).takeControl(
        target,
        conversationId ?? task?.conversationId,
        threadRootId ?? task?.threadRootId,
        client,
        replaceHuman
      )
    },
    async computerRelease(target) {
      v.record(target)
      return (await computer(target.botId, target.taskRunId, true)).releaseControl(target, client)
    },
    async computerInput(input) {
      v.record(input)
      v.record(input.target)
      v.record(input.input)
      await (
        await computer(input.target.botId, input.target.taskRunId, true)
      ).humanInput(input.target, input.input, client)
    },
    async status() {
      return {
        protocol: BOT_PROTOCOL_VERSION,
        buildId: host.buildId,
        hostId: host.id,
        dataEpoch: store.dataEpoch(),
        errorTrays: host.getErrorTrays(),
        platform: process.platform,
        runtimeReady: host.ready,
        ...(store.defaultWorkspacePath ? { sharedWorkspace: store.defaultWorkspacePath } : {}),
        limits: { bots: store.maxBots, routines: BOT_MAX_ROUTINES },
        ...(host.storage ? { storage: host.storage.view() } : {}),
        ...(host.computer ? { computer: host.computer.status() } : {}),
        capabilities: [
          ...(host.nativeComputer ? ["windows-native-computer"] : []),
          ...(store.defaultWorkspacePath ? ["shared-workspace"] : []),
          ...(host.modelChecks ? ["model-checks"] : []),
          "notifications",
          "run-output-pages-v1",
          BOT_WORK_PAGES_CAPABILITY,
          "primary-bot-v1",
          "pinned-order",
          "bot-profile-management",
          "bot-profile-title",
          "scoped-bot-create",
          "bot-introduction-v1",
          "bot-introduction-question-v1",
          "bot-create-review-v1",
          "bot-update-receipts",
          "bot-delete-epoch",
          "clone-epoch",
          "teach-scope-v2",
          ...(host.commandExecutionAvailable ? ["harness-context"] : []),
          "error-trays",
          "private-skill-deletion",
          "skill-save-receipts",
          "skill-dependency-history",
          ...(host.commandExecutionAvailable ? ["skill-dependencies"] : []),
          "task-browser",
          "group-update-receipts",
          "group-member-controls",
          BOT_SINGLE_BOT_ROOM_CAPABILITY,
          BOT_PEER_FILES_CAPABILITY,
          BOT_USER_SKILLS_CAPABILITY,
          "recovery-receipts",
          "computer-client-ownership",
          "local-project-permission",
          "message-threads",
          "message-reactions",
          "skill-references",
          "message-replies",
          "content-search",
          "message-recipients",
          "entity-references",
          "inline-references",
          "selection-quotes-v1",
          "usage-budgets",
          "routine-management",
          BOT_EVENT_STATE_CAPABILITY,
          "routine-save-outcomes",
          "routine-editor",
          "routine-readiness-state",
          "routine-run-version",
          "routine-skills",
          "skill-trials",
          "skill-trial-review-epoch",
          "async-tasks",
          ...(host.webhooks ? ["webhooks"] : []),
          ...(host.backups ? ["scheduled-backups"] : []),
          "shell-job-controls-v1",
          ...(host.commandExecutionAvailable ? ["background-shell-jobs"] : []),
          ...(host.commandServicesAvailable ? ["cross-turn-shell-services"] : []),
          "plugin-commands",
          ...(host.functionSessions ? ["plugin-panes"] : []),
          "context-import",
          "routine-history",
          BOT_ROUTINE_DISPATCH_CAPABILITY,
          "memory-synthesis",
          "memory-scopes",
          "skill-library",
          BOT_SKILL_MAINTENANCE_CAPABILITY,
          "installed-skills",
          "avatar-images",
          "mutation-data-epoch",
          "mutation-data-epoch-v2",
          "memory-mutation-epoch",
          "private-memory-receipts",
          "local-tool-permission",
          "peer-exchange-v1",
          "run-history",
          "interaction-history",
          "typed-user-forms",
          "approval-rules",
          "approval-deny-rules",
          "auto-review",
          "workflow-worktrees",
          "workflow-controls",
          "task-model-budget",
          "current-task-instructions",
          "file-lifecycle",
          ...(host.files ? ["file-delete-epoch"] : [])
        ],
        error: host.lastError ?? host.teach?.lastError ?? host.unavailableReason ?? null
      }
    },
    async primaryBot() {
      return store.primary.read()
    },
    async changePrimaryBot(input) {
      return store.primary.change(input)
    },
    async ensurePrimaryBot(input) {
      return store.primary.ensure(input)
    },
    async changePrimaryCheckIn(input) {
      return store.primary.configureCheckIn(input)
    },
    async snapshot(input) {
      return {
        ...store.snapshot(input, host.id),
        hostId: host.id,
        errorTrays: host.getErrorTrays()
      }
    },
    async notificationEvents(input) {
      return store.workNotifications.events(input, host.id)
    },
    async openRuns(input) {
      return store.workPages.openRuns(input, host.id)
    },
    async pendingInteractions(input) {
      return store.workPages.pendingInteractions(input, host.id)
    },
    async pendingCard(input) {
      return store.workPages.pendingCard(input, host.id)
    },
    async trackedWork(input) {
      return store.workPages.trackedWork(input, host.id)
    },
    async runOutput(input) {
      return { ...store.runOutput(input), hostId: host.id }
    },
    async getErrorTrays() {
      return host.getErrorTrays()
    },
    async dismissErrorTray(input) {
      return host.dismissErrorTray(input)
    },
    async clearErrorTrays(input) {
      return host.clearErrorTrays(input)
    },
    async events(after) {
      return store.events(after)
    },
    async create(input) {
      return store.createBot(input)
    },
    async clone(input) {
      return store.cloneBot(input)
    },
    async importThreadContext(input) {
      return store.contextImports.import(input)
    },
    async setReadState(input) {
      return store.setReadState(input)
    },
    async reorderPinned(input) {
      return store.reorderPinned(input)
    },
    async routineHistory(input) {
      return store.routineHistory(input)
    },
    async routineDispatchHistory(input) {
      return readBotRoutineDispatchHistory(store, input)
    },
    async update(input) {
      return store.updateBot(input)
    },
    async delete(input) {
      v.record(input)
      store.deleteBot(input.id, input.revision, input.expectedDataEpoch)
      host.functionSessions?.closeBot(input.id)
      await Promise.all([
        host.computer?.releaseBot(input.id),
        host.nativeComputer?.releaseBot(input.id),
        host.secretRequests?.vault.forgetBot(input.id)
      ])
    },
    async updateGroup(input) {
      const group = store.updateGroup(input)
      host.tick()
      return group
    },
    async createGroup(input) {
      return store.createGroup(input)
    },
    async send(input) {
      v.record(input)
      const references = parseBotEntitySelections(input.references ?? [])
      const receipt = store.send(
        input,
        undefined,
        !store.hasSendReceipt(input.nonce) && references.some((item) => item.kind === "connector")
          ? await host.connectors()
          : []
      )
      host.tick()
      return receipt
    },
    async messages(input) {
      v.record(input)
      return store.messages(
        input.conversationId,
        input.before,
        input.limit,
        input.after,
        input.threadRootId
      )
    },
    async message(input) {
      return store.message(input)
    },
    async cancel(id) {
      const run = store.cancel(id)
      host.tick()
      return run
    },
    async answer(input) {
      v.record(input)
      const interaction = store.getInteraction(input.id)
      const help = interaction.kind === "question" ? readBotComputerHelp(interaction.prompt) : null
      if (help && input.answer === "done") {
        return botComputerHelpCompletion(store).answer(input, {
          hostId: host.id,
          dataEpoch: store.dataEpoch(),
          client,
          interaction: () => store.getInteraction(input.id),
          validateRun: () => {
            const run = store.getRun(interaction.runId)
            if (
              run.botId !== help.botId ||
              run.leaseOwner !== host.id ||
              run.fence !== help.runFence ||
              run.conversationId !== help.conversationId ||
              run.threadRootId !== help.threadRootId ||
              (help.taskRunId && help.taskRunId !== run.id) ||
              (run.status !== "waiting_input" && run.status !== "running") ||
              (run.leaseUntil ?? 0) <= store.now()
            )
              throw new BotDomainError("stale_interaction", "帮助所属任务已停止或变化")
            store.getBot(help.botId)
            host.assertComputerSupervision()
          },
          release: async (returning) => {
            if (returning.backend === "windows-native") {
              const broker = nativeComputer(returning.target, true)
              broker.assertHumanClient(help.botId, client, help.taskRunId)
              return {
                backend: "windows-native",
                target: await broker.releaseControl(returning.target, client)
              }
            }
            const broker = await computer(help.botId, help.taskRunId, true)
            broker.assertHumanClient(help.botId, client, help.taskRunId)
            return {
              backend: "browser",
              target: await broker.releaseControl(returning.target, client)
            }
          },
          commit: (value, returned) => store.answerComputerHelp(value, returned)
        })
      }
      if (
        interaction.kind === "approval" &&
        input.answer !== "reject" &&
        readBotSecretCard(interaction.prompt)
      )
        throw new Error("请通过安全输入卡片提交，不要在普通回答中填写密码")
      return store.answerInteraction(input)
    },
    async answerIntroductionQuestion(input) {
      const receipt = store.introductionQuestions.reply(input)
      if (receipt.send) host.tick()
      return receipt
    },
    async approvalRules(botId) {
      return store.approvalRules.read(botId)
    },
    async autoReviewSettings(botId) {
      return store.autoReview.read(botId)
    },
    async changeAutoReview(input) {
      return store.autoReview.change(input)
    },
    async changeApprovalRule(input) {
      return store.approvalRules.change(input)
    },
    async memoryPolicy(id) {
      return store.memory.policy(v.identifier(id))
    },
    async setMemoryPolicy(input) {
      return store.memory.setPolicy(input)
    },
    async retryMemory(input) {
      return store.memory.retry(input)
    },
    async sharedMemories(input) {
      return store.sharedMemories.list(input)
    },
    async saveSharedMemory(input) {
      return store.sharedMemories.save(input)
    },
    async deleteSharedMemory(input) {
      return store.sharedMemories.remove(input)
    },
    async memories(id) {
      return store.memories(id)
    },
    async saveMemory(input) {
      return store.saveMemory(botMemorySaveInput.parse(input))
    },
    async deleteMemory(input) {
      const request = botMemoryDeleteInput.parse(input)
      return store.deleteMemory(
        request.botId,
        request.id,
        request.revision,
        request.expectedDataEpoch,
        request.nonce
      )
    },
    async installedSkills(botId) {
      store.getBot(v.identifier(botId))
      await host.refreshSkills(true)
      const skills = store.externalSkills
        .list(botId)
        .map(({ id, name, version, sourceName, verified }) => ({
          id,
          name,
          version,
          sourceName,
          verified
        }))
      return { ...store.externalSkills.status(), skills }
    },
    async inspectInstalledSkill(input) {
      const { botId, id, version } = botSkillSelection.parse(input)
      await host.refreshSkills()
      return store.externalSkills.current(botId, id, version)
    },
    async skillLibrary() {
      return store.skillLibrary.list()
    },
    async setSkillEnabled(input) {
      const result = store.skillLibrary.setEnabled(input)
      host.tick()
      return result
    },
    async publishSkill(input) {
      return store.skillLibrary.publish(input)
    },
    async withdrawSkill(input) {
      const receipt = store.skillLibrary.withdraw(input)
      host.tick()
      return receipt
    },
    async asyncTasks(input) {
      return listBotAsyncTasks(store, input)
    },
    async shellJob(input) {
      return store.shellJobs.read(input)
    },
    async stopShellJob(input) {
      return store.shellJobs.stop(input)
    },
    async availableSkills(botId) {
      store.getBot(v.identifier(botId))
      await host.refreshSkills()
      return store.skillLibrary.available(botId).map((skill) => ({
        id: skill.id,
        botId,
        name: skill.name,
        version: skill.version,
        enabled: skill.enabled,
        verified: skill.verified,
        createdAt: skill.createdAt,
        scope: skill.scope,
        userEditable: skill.userEditable,
        enablementRevision: skill.enablementRevision,
        sourceName: skill.sourceName
      }))
    },
    async skills(id) {
      return store.skills(id)
    },
    async skillMaintenance(input) {
      return store.skillMaintenance.view(input)
    },
    async configureSkillMaintenance(input) {
      return store.skillMaintenance.configure(input)
    },
    async changeSkillMaintenance(input) {
      return store.skillMaintenance.change(input)
    },
    async runSkillMaintenance(input) {
      return store.skillMaintenance.run(input)
    },
    async saveSkill(input) {
      v.record(input)
      const skill = store.saveSkill(input)
      host.tick()
      return skill
    },
    async deleteSkill(input) {
      const receipt = store.deleteSkill(input)
      host.tick()
      return receipt
    },
    async routines(id) {
      return store.routines(id)
    },
    async deleteRoutine(input) {
      return store.deleteRoutine(input)
    },
    async saveRoutine(input) {
      v.record(input)
      return store.saveRoutine(input, { kind: "human" })
    }
  }
}

export function encodeBotFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8")
  if (body.length > BOT_RPC_MAX_BYTES)
    throw new BotDomainError("response_too_large", "数据过大，请分页读取")
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

export function decodeBotFrames(socket: Socket, receive: (value: unknown) => void): void {
  let header: Buffer | undefined = Buffer.allocUnsafe(4)
  let headerBytes = 0
  let size = 0
  let body: Buffer | undefined
  let bodyBytes = 0
  let closed = false
  const cleanup = () => {
    closed = true
    header = undefined
    body = undefined
    headerBytes = bodyBytes = size = 0
    socket.off("data", onData)
    socket.off("close", cleanup)
    socket.off("error", cleanup)
  }
  const fail = () => {
    cleanup()
    socket.destroy()
  }
  const onData = (chunk: Buffer) => {
    if (closed || socket.destroyed) return
    let offset = 0
    while (offset < chunk.length && !closed && !socket.destroyed) {
      if (!size) {
        if (!headerBytes && chunk.length - offset >= 4) {
          size = chunk.readUInt32BE(offset)
          offset += 4
        } else {
          const count = Math.min(4 - headerBytes, chunk.length - offset)
          chunk.copy(header!, headerBytes, offset, offset + count)
          headerBytes += count
          offset += count
          if (headerBytes < 4) return
          size = header!.readUInt32BE(0)
          headerBytes = 0
        }
        if (size < 2 || size > BOT_RPC_MAX_BYTES) {
          fail()
          return
        }
      }
      let complete: Buffer
      if (!body && chunk.length - offset >= size) {
        // Ordinary coalesced frames need no body allocation or additional copy.
        complete = chunk.subarray(offset, offset + size)
        offset += size
      } else {
        // Allocate once per fragmented frame. Repeated concatenation of a
        // growing prefix made file downloads quadratic in socket fragmentation.
        body ??= Buffer.allocUnsafe(size)
        const count = Math.min(size - bodyBytes, chunk.length - offset)
        chunk.copy(body, bodyBytes, offset, offset + count)
        bodyBytes += count
        offset += count
        if (bodyBytes < size) return
        complete = body
      }
      body = undefined
      bodyBytes = size = 0
      try {
        receive(JSON.parse(complete.toString("utf8")))
      } catch {
        fail()
        return
      }
      if (socket.destroyed) cleanup()
    }
  }
  socket.on("data", onData)
  socket.once("close", cleanup)
  socket.once("error", cleanup)
}

export class BotRpcServer {
  readonly server: Server
  private readonly sockets = new Map<Socket, AbortController>()
  private inFlight = 0
  private stopping = false
  private closing?: Promise<void>
  private drained?: () => void
  private restarting = false
  private restartScheduled = false
  private restartAttempt?: {
    id: string
    abort: AbortController
    committed: boolean
  }
  constructor(
    private readonly host: BotHost,
    private readonly token: string,
    private readonly restart?: () => Promise<void>
  ) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Host token must contain 32 random bytes")
    this.server = createServer((socket) => this.accept(socket))
    this.server.maxConnections = 32
  }

  private accept(socket: Socket): void {
    if (this.stopping) {
      socket.destroy()
      return
    }
    const client = new AbortController()
    const api = createBotAPI(this.host, client.signal)
    this.sockets.set(socket, client)
    socket.on("error", () => {})
    socket.on("close", () => {
      client.abort(new BotDomainError("host_disconnected", "控制端已断开，请重新接管浏览器"))
      this.sockets.delete(socket)
    })
    socket.setTimeout(10_000, () => socket.destroy())
    let authenticated = false,
      pending = 0
    const ids = new Set<string>()
    decodeBotFrames(socket, (value) => {
      if (this.stopping) {
        socket.destroy()
        return
      }
      const request = v.record(value),
        id = v.identifier(request.id)
      if (!authenticated) {
        const supplied =
          typeof request.token === "string" ? Buffer.from(request.token) : Buffer.alloc(0)
        const expected = Buffer.from(this.token)
        if (
          request.version !== BOT_PROTOCOL_VERSION ||
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        ) {
          socket.destroy()
          return
        }
        authenticated = true
        socket.setTimeout(0)
        socket.write(
          encodeBotFrame({
            id,
            ok: true,
            value: { version: BOT_PROTOCOL_VERSION }
          })
        )
        return
      }
      if (pending >= BOT_RPC_MAX_PENDING || ids.has(id)) {
        socket.destroy()
        return
      }
      pending++
      this.inFlight++
      ids.add(id)
      void this.dispatch(api, request.method, request.input, id, client.signal)
        .then(
          (result) => {
            const restart =
              request.method === "__restartIfIdle" &&
              this.restartAttempt?.id === id &&
              this.restartAttempt.committed
                ? () => this.finishRestart()
                : undefined
            // A client disconnecting before its ACK cannot strand a fenced Host.
            if (restart) setTimeout(restart, 1000).unref()
            this.reply(socket, { id, ok: true, value: result ?? null }, restart)
          },
          (error) =>
            this.reply(socket, {
              id,
              ok: false,
              error: serializeBotFailure(error, {
                knownSecrets: [this.token],
                correlationId: id
              })
            })
        )
        .finally(() => {
          pending--
          this.inFlight--
          ids.delete(id)
          if (this.inFlight === 0) {
            this.drained?.()
            this.drained = undefined
          }
        })
    })
  }

  private reply(
    socket: Socket,
    response: {
      id: string
      ok: boolean
      value?: unknown
      error?: { code: string; message: string }
    },
    flushed?: () => void
  ): void {
    if (socket.destroyed) return
    try {
      if (socket.writableLength > BOT_RPC_MAX_BYTES) {
        socket.destroy()
        return
      }
      socket.write(encodeBotFrame(response), flushed)
    } catch (error) {
      if (error instanceof BotDomainError && error.code === "response_too_large") {
        // The request completed, but its result could not fit in one frame. Keep the
        // authenticated connection usable and return a small, actionable domain error.
        try {
          socket.write(
            encodeBotFrame({
              id: response.id,
              ok: false,
              error: { code: error.code, message: error.message }
            })
          )
          return
        } catch {
          /* A closed or backpressured connection still retires normally. */
        }
      }
      socket.destroy()
    }
  }

  private finishRestart(): void {
    if (this.restartScheduled) return
    this.restartScheduled = true
    void this.restart?.().catch((error) => {
      // The Host stays fenced if cleanup fails; never resume with partially closed services.
      console.error(
        "[BotHost] Version switch failed",
        error instanceof Error ? error.name : "unknown"
      )
    })
  }

  private async dispatch(
    api: CoworkBotAPI,
    method: unknown,
    input: unknown,
    id: string,
    signal: AbortSignal
  ): Promise<unknown> {
    // Pending ownership reads are counted by the existing connection admission
    // bound. Host coalesces concurrent metadata probes; no scans block the loop.
    if (this.stopping) throw new BotDomainError("host_disconnected", "Bot 后台正在停止")
    await this.host.checkOwnership()
    // Ownership I/O must not admit a mutation after shutdown's synchronous fence.
    if (this.stopping) throw new BotDomainError("host_disconnected", "Bot 后台正在停止")
    if (this.restarting) throw new BotDomainError("host_restarting", "Bot 后台正在重启，请稍后重试")
    if (method === "__restartIfIdle") {
      const value = v.record(input)
      if (!this.restart) throw new BotDomainError("restart_unavailable", "此后台未配置重启服务")
      if (this.inFlight !== 1) return { accepted: false, reason: "后台正在处理请求，请稍后重试" }
      const expectedHostId = v.identifier(value.hostId)
      const attempt = { id, abort: new AbortController(), committed: false }
      const result = await this.host.prepareOwnedIdleRestart(expectedHostId, {
        signal: AbortSignal.any([signal, attempt.abort.signal]),
        begin: () => {
          // Host has passed its synchronous guards. Publish the RPC fence
          // before its physical reader awaits, without fencing busy denials.
          this.restartAttempt = attempt
          this.restarting = true
        },
        restore: () => {
          // Only Host's exact, still-owned rollback may reopen this admission.
          // stop/ownership loss/server.close never call this callback.
          if (this.stopping || this.restartAttempt !== attempt)
            throw new BotDomainError("host_disconnected", "Bot 后台正在停止")
          this.restartAttempt = undefined
          this.restarting = false
        },
        assertCurrent: () => {
          if (this.stopping || (this.restartAttempt && this.restartAttempt !== attempt))
            throw new BotDomainError("host_disconnected", "Bot 后台正在停止")
        }
      })
      if (this.stopping || attempt.abort.signal.aborted)
        throw new BotDomainError("host_disconnected", "Bot 后台正在停止")
      attempt.committed = result.accepted
      return result
    }
    if (typeof method !== "string" || !Object.hasOwn(api, method))
      throw new BotDomainError("unknown_method", "未知 Bot 操作")
    // The public API owns validation. Internal run leases, effects and peer authority are never RPC methods.
    return guardBotRpcMutationEpoch(
      method,
      input,
      () => this.host.store.dataEpoch(),
      () => (api[method as keyof CoworkBotAPI] as (input: unknown) => Promise<unknown>)(input)
    )
  }

  async listen(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject)
      this.server.listen(path, () => {
        this.server.off("error", reject)
        resolve()
      })
    })
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.stopping = true
    this.restartAttempt?.abort.abort(new BotDomainError("host_disconnected", "Bot 后台正在停止"))
    let closed!: () => void
    const listener = new Promise<void>((resolve) => (closed = resolve))
    const requests = this.inFlight
      ? new Promise<void>((resolve) => (this.drained = resolve))
      : Promise.resolve()
    // Publish the shared join before disconnect callbacks can request cleanup.
    // APIs already entered may settle their receipts; the Host's shutdown deadline
    // bounds a stuck operation before SQLite or its lifetime lock is released.
    this.closing = Promise.all([listener, requests]).then(() => {})
    for (const [socket, client] of this.sockets) {
      client.abort(new BotDomainError("host_disconnected", "控制端已断开，请重新接管浏览器"))
      socket.destroy()
    }
    this.server.close(() => closed())
    return this.closing
  }
}
