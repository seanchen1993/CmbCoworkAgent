import { botModelInvocationObserver } from "./model-error-diagnostic-scope"
import type { BotHarnessRunContext } from "./harness-context-contract"
import { harnessContextHookFields } from "../harness-board/agent-context-core"
import { botWorkflowModelFetch } from "./workflow-budget"
import { createHash } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { dirname, join, relative } from "node:path"
import { z } from "zod"
import { createToolHookMiddlewareCore } from "../agent/tool-hooks-core"
import { createHookScope } from "../hooks/scope-core"
import { executePromptHook, runHooksCore, type HookContext } from "../hooks/runner-core"
import { withHookRunnerServices, type HookRunnerServices } from "../hooks/runner-services"
import { executeHttpHook } from "../hooks/http-runner"
import type { HookConfig, HookEvent, HookResult } from "../hooks/types"
import { createConfiguredCmbModel } from "../models/model-factory"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import { readBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import {
  botHookEnvironment,
  botExecutionConfigSchema,
  botShellResultSandboxName,
  botShellReadOnly,
  botShellSandboxName
} from "./shell-contract"
import { BotShellProcess } from "./shell-process"
import { BotProjectFiles } from "./project-files"
import { withBotProjectMutation } from "./project-lock"
import { readBotSkillHooks } from "./skill-hook-source"
import { canonicalJson } from "./validation"
import { readSkillActivation, readSkillHookReceipt } from "./skill-hook-state"
import type { McpCapabilityTool } from "../mcp/capability-types"
import { ToolMessage } from "@langchain/core/messages"
import { botWorktreeSkillRoot } from "./worktree-skill"
import { botWorkflowChildAllows } from "./workflow-child-policy"
import { BOT_SUPPORTED_SKILL_HOOK_EVENTS } from "../../shared/bot-skill-hooks"
import { BotRuntimeHooks, type BotRuntimeOwnedHook } from "./runtime-hooks"
import { BotWorkspaceSetup } from "./workspace-setup"
import { appendBotMcpHookFeedback } from "./mcp-result"
import type { botFailureFuse } from "./failure-fuse"

const digest = (input: unknown) =>
  createHash("sha256")
    .update(canonicalJson(JSON.parse(JSON.stringify(input))))
    .digest("hex")
const receipt = z
  .object({
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    blocked: z.boolean(),
    decision: z.enum(["approve", "block"]).optional(),
    reason: z.string().optional(),
    sandbox: z.enum(["linux-codex-cgroup-v2", "windows-codex-atomic-job-v2"]).optional()
  })
  .strict()
type Approval = (
  id: string,
  action: unknown,
  operation: () => Promise<string>,
  beforeStart?: () => Promise<void>
) => Promise<string>
type SkillOwnedHook = HookConfig & {
  configured?: false
  skillId: string
  skillVersion: number
  skillName: string
  pluginId?: string
}
type OwnedHook = SkillOwnedHook | BotRuntimeOwnedHook

/** Native SDK consumers inspect exit codes and artifact IDs, so feedback must
 * not turn their receipt into an unparseable string. Plain rejection stays text. */
function appendNativeHookFeedback(serialized: string, feedback: string): string {
  if (!feedback) return serialized
  try {
    const value: unknown = JSON.parse(serialized)
    if (value && typeof value === "object" && !Array.isArray(value))
      return JSON.stringify({ ...value, hookFeedback: feedback })
  } catch {
    /* Rejected or replaced results keep their original failure path. */
  }
  return `${serialized}\n\n${feedback}`
}

/** Cmb Hook execution with Bot-owned grants and durable effects. Configuration
 * is pinned from desktop-owned sources; model arguments cannot add Hooks. */
export class BotSkillHooks {
  private readonly loaded = new Map<string, { version: number; hooks: SkillOwnedHook[] }>()
  private readonly scope = createHookScope()
  private readonly services: HookRunnerServices
  private readonly configured: BotRuntimeHooks
  private readonly toolContext = new AsyncLocalStorage<
    Pick<HookContext, "toolName" | "toolArgs" | "pluginId">
  >()
  constructor(
    private readonly request: BotRuntimeRequest,
    private readonly modelFile: string,
    private readonly snapshot: BotModelSnapshot,
    private readonly shell: BotShellProcess,
    private readonly check: () => void,
    private readonly approve: Approval,
    private readonly failureFuse?: ReturnType<typeof botFailureFuse>,
    private readonly harness?: BotHarnessRunContext | null,
    private readonly assertHarnessCurrent?: () => Promise<void>
  ) {
    this.configured = new BotRuntimeHooks(request, snapshot)
    this.services = {
      getHookLoggingConfig: () => ({ enabled: true, diagnostic: false }),
      getUserInfo: () => null, // Bot tasks do not inherit desktop employee credentials.
      createPromptModel: (ref) => {
        const selected = ref ?? request.bot.modelRef ?? snapshot.defaultRef
        const config = snapshot.models.find(
          (model) => model.ref === selected || model.id === selected
        )
        if (!config) throw new BotDomainError("hook_model_unavailable", "Hook 指定的模型未配置")
        return createConfiguredCmbModel(config, {
          observeInvocation: botModelInvocationObserver(config.apiKey ? [config.apiKey] : []),
          fetch: botWorkflowModelFetch(request, config, fetch, () => this.current()),
          purpose: "function-completion"
        })
      },
      forceSynchronous: true,
      signal: request.signal,
      assertCurrent: () => this.current(),
      persistHookResultRecord: (event, hook, result) => {
        this.check()
        request.store.activity(
          request.lease,
          `${(hook as OwnedHook).skillName ?? "技能"} · ${event}：${result.blocked ? "已拦截" : result.exitCode === 0 ? "已返回检查结果" : "执行失败"}`
        )
      },
      execute: (input) => this.execute(input)
    }
  }

  private async current(): Promise<void> {
    await this.assertHarnessCurrent?.()
    this.check()
    this.configured.assertCurrent()
    const now = await readBotModelSnapshot(this.modelFile)
    if (
      canonicalJson({
        execution: now.execution ?? null,
        hookSources: now.hookSources ?? null,
        harnessSources: now.harnessSources ?? null,
        models: now.models,
        defaultRef: now.defaultRef
      }) !==
      canonicalJson({
        execution: this.snapshot.execution ?? null,
        hookSources: this.snapshot.hookSources ?? null,
        harnessSources: this.snapshot.harnessSources ?? null,
        models: this.snapshot.models,
        defaultRef: this.snapshot.defaultRef
      })
    )
      throw new BotDomainError(
        "hook_configuration_changed",
        "Hook 执行或模型配置已变化，请重新发起任务"
      )
    this.check()
  }

  assertConfiguration(): void {
    this.configured.assertCurrent()
  }

  async refresh(): Promise<void> {
    await this.assertHarnessCurrent?.()
    const { store, run, bot } = this.request
    this.check()
    await this.configured.refresh()
    const references = new Map(
      [...store.skillReferences.forRun(run.id), ...store.skillLibrary.referencesForRun(run.id)].map(
        (item) => [item.id, item]
      )
    )
    for (const reference of references.values()) {
      if (!reference.id.startsWith("desktop:")) continue
      const source = store.externalSkills.source(bot.id, reference.id, reference.version)
      if (this.loaded.get(reference.id)?.version === reference.version) continue
      const hooks = (await readBotSkillHooks(source)).map((hook) => ({
        ...hook,
        skillId: source.id,
        skillVersion: reference.version,
        skillName: source.name,
        skillPath: source.filePath,
        skillRoot: source.rootPath,
        pluginId: source.pluginId ?? undefined,
        pluginName: source.pluginName ?? undefined
      }))
      this.check()
      const supported = new Set<HookEvent>(BOT_SUPPORTED_SKILL_HOOK_EVENTS)
      const unavailable = hooks.find((hook) => hook.enabled && !supported.has(hook.event))
      if (unavailable)
        throw new BotDomainError(
          "hook_event_unavailable",
          `此技能需要 ${unavailable.event} Hook，Bot 尚未接通该事件，请先在 CMBDevClaw 原任务中使用`
        )
      this.loaded.set(reference.id, { version: reference.version, hooks })
    }
    this.restoreScope()
    // Validate even when the current event has no matching Hook.
    const configured = this.configured.candidates({}, this.scope)
    if (
      this.request.worktree &&
      configured.some(
        (hook) => hook.owner !== "workspace" && hook.type !== "prompt" && hook.type !== "http"
      )
    )
      throw new BotDomainError(
        "hook_worktree_source",
        "隔离子任务不能在外部全局或插件目录执行命令 Hook，请将此检查配置到项目目录"
      )
  }

  private restoreScope(): void {
    for (const pluginId of this.configured.pluginIds())
      if (
        readSkillHookReceipt(
          this.request.store,
          this.request.run.id,
          `hook-plugin:${digest(pluginId)}`
        ) === true
      )
        this.scope.activatePlugin(pluginId)
    for (const { hooks } of this.loaded.values())
      for (const hook of hooks)
        if (
          readSkillActivation(
            this.request.store,
            this.request.run.id,
            hook.skillId,
            hook.skillVersion
          )
        )
          this.scope.activateSkill(hook.skillName, hook.pluginId, hook.hookSourceRoot)
  }

  private candidates(event: HookEvent, context: HookContext, skillId?: string): OwnedHook[] {
    const { store, run } = this.request
    const activeSkills = [...this.loaded.values()]
      .flatMap((item) => item.hooks)
      .filter((hook) => !skillId || hook.skillId === skillId)
      .filter((hook) => {
        if (event === "PreSkillUse" || event === "PostSkillUse") return true
        if (!readSkillActivation(store, run.id, hook.skillId, hook.skillVersion)) return false
        this.scope.activateSkill(hook.skillName, hook.pluginId, hook.hookSourceRoot)
        return true
      })
    return [...this.configured.candidates(context, this.scope), ...activeSkills]
  }

  async initializeWorkspace(): Promise<void> {
    await this.refresh()
    const root = this.request.bot.workspacePath
    if (!root) return
    const context = { setupTrigger: "init" as const }
    const hooks = this.candidates("Setup", context).filter(
      (hook) => hook.enabled && hook.event === "Setup"
    )
    if (!hooks.length) return
    const project = await BotProjectFiles.open(root, [dirname(this.modelFile)])
    const configuration = digest(hooks)
    const setup = new BotWorkspaceSetup(this.request, project.identity, configuration, async () => {
      await this.current()
      await project.assertCurrent()
    })
    await setup.run(() => this.run("Setup", context, "lifecycle:workspace-setup"))
  }

  async run(
    event: HookEvent,
    context: HookContext,
    invocation: string,
    skillId?: string
  ): Promise<HookResult | null> {
    await this.refresh()
    const { run, bot } = this.request
    const effects = this.request.store.effects(run.id)
    const candidates = this.candidates(event, context, skillId)
    const prepared = candidates
      .filter(
        (hook) =>
          !hook.once ||
          !effects.some((effect) => {
            const prefix = `hook:${digest([run.id, hook.skillId, hook.skillVersion, hook.id, event])}:`
            return (
              effect.id.startsWith(prefix) &&
              effect.id !== prefix + digest(invocation).slice(0, 24) &&
              effect.status === "succeeded" &&
              effect.result &&
              receipt.parse(JSON.parse(effect.result)).exitCode === 0
            )
          })
      )
      // Durable receipts own once/replay semantics; the desktop's in-memory
      // once cache must not hide a required result when this graph is resumed.
      .map((hook) => {
        if (!this.request.worktree || hook.type === "prompt" || hook.type === "http")
          return { ...hook, once: false }
        if (hook.configured) {
          if (hook.owner !== "workspace") return { ...hook, once: false }
          const root = this.request.worktree.boundary.workspaceRoot
          return {
            ...hook,
            once: false,
            hookSourceRoot: root,
            hookSourcePath: join(root, relative(hook.hookSourceRoot!, hook.hookSourcePath!))
          }
        }
        const source = this.request.store.externalSkills.source(
          bot.id,
          hook.skillId,
          hook.skillVersion
        )
        const root = botWorktreeSkillRoot(this.request.worktree.boundary, source)
        return {
          ...hook,
          once: false,
          hookSourceRoot: root,
          hookSourcePath: join(root, relative(source.rootPath, hook.hookSourcePath!)),
          skillRoot: root,
          skillPath: join(root, "SKILL.md")
        }
      })
    const result = await withHookRunnerServices(this.services, () =>
      runHooksCore(prepared, event, {
        ...harnessContextHookFields(this.harness?.context),
        harnessNodeName: this.harness?.harnessNodeName,
        harnessNodeStatus: this.harness?.harnessNodeStatus,
        ...context,
        workspacePath: bot.workspacePath ?? undefined,
        workspaceHookCwd: bot.workspacePath ?? undefined,
        sessionId: run.id,
        turnId: invocation,
        agentId: context.subagent?.id ?? bot.id
      })
    )
    if (!result?.requiredSkill) return result
    const matches = this.request.store.skillLibrary
      .available(bot.id)
      .filter(
        (skill) =>
          skill.id === result.requiredSkill ||
          skill.name.toLowerCase() === result.requiredSkill!.toLowerCase()
      )
    const guidance =
      matches.length === 1
        ? `Hook requires skill ${JSON.stringify(matches[0].name)}. Read it with read_skill using id ${JSON.stringify(matches[0].id)} before retrying; existing approvals still apply.`
        : `Hook requested ${JSON.stringify(result.requiredSkill)}, but the enabled catalog has no unique matching skill. Ask the user to select or enable it.`
    return {
      ...result,
      additionalContext: [result.additionalContext, guidance].filter(Boolean).join("\n\n"),
      ...(result.blocked ? { reason: [result.reason, guidance].filter(Boolean).join("\n\n") } : {})
    }
  }

  async hasActiveEvent(event: HookEvent): Promise<boolean> {
    await this.refresh()
    if (this.configured.candidates({}, this.scope).some((hook) => hook.event === event)) return true
    return [...this.loaded.values()].some(({ hooks }) =>
      hooks.some(
        (hook) =>
          hook.enabled &&
          hook.event === event &&
          Boolean(
            readSkillActivation(
              this.request.store,
              this.request.run.id,
              hook.skillId,
              hook.skillVersion
            )
          )
      )
    )
  }

  /** Emitted only for an actual pending manual approval. Values supplied through
   * the secure-input channel are never part of this tool context. */
  async notifyPermission(interactionId: string, key: string, action: unknown): Promise<void> {
    const { store, lease } = this.request
    if (store.hookNotifications.current(lease)) return
    const approval = store.getInteraction(interactionId)
    if (approval.kind !== "approval" || approval.status !== "pending") return
    const context: HookContext = {
      ...this.toolContext.getStore(),
      notificationType: "permission_prompt",
      permissionMode: "approve"
    }
    // The run already pinned and loaded its Hook sources before tool dispatch.
    // A pure lookup avoids refreshing configuration outside the waiting capability.
    if (
      !this.candidates("Notification", context).some(
        (hook) => hook.enabled && hook.event === "Notification"
      )
    )
      return
    await store.hookNotifications.run(lease, { key, interactionId, action }, async (invocation) => {
      try {
        await this.run("Notification", { ...context, toolCallId: invocation }, invocation)
      } catch (error) {
        if (!(error instanceof BotDomainError) || error.code !== "hook_declined") throw error
        this.check()
        store.activity(lease, "未执行审批通知，原操作仍需单独确认")
      }
    })
  }

  middleware(contextOverride?: Pick<HookContext, "pluginId">, modInputTarget?: string) {
    const middleware = createToolHookMiddlewareCore(
      {
        manageMods: false,
        modInputTarget,
        runFailureHooks: true,
        onToolFailureDecision: this.failureFuse?.failure,
        onToolSuccess: this.failureFuse?.success,
        onFailureFuseNotice: this.failureFuse?.notice,
        skipToolNames: contextOverride
          ? undefined
          : new Set(["call_connector_tool", "read_connector_resource"]),
        workspacePath: this.request.bot.workspacePath ?? "",
        threadId: this.request.run.id,
        hookTurnId: this.request.run.id,
        agentId: this.request.bot.id,
        hookScope: this.scope,
        // The scoped runner refreshes the installed versions before resolving.
        resolveHooksForContext: () => []
      },
      (_hooks, event, context) => {
        if (!context.toolCallId)
          throw new BotDomainError("hook_call_identity", "工具 Hook 缺少稳定任务标识")
        return this.run(event, { ...context, ...contextOverride }, context.toolCallId)
      }
    )
    const wrap = middleware.wrapToolCall!
    middleware.wrapToolCall = (request, handler) =>
      this.toolContext.run(
        {
          toolName: request.toolCall.name,
          toolArgs: request.toolCall.args,
          ...contextOverride
        },
        () =>
          wrap(request, (effective: typeof request) =>
            this.toolContext.run(
              {
                toolName: effective.toolCall.name,
                toolArgs: effective.toolCall.args,
                ...contextOverride
              },
              () => handler(effective)
            )
          )
      )
    return middleware
  }

  /** Called only after MCP has resolved an authorized concrete capability. The
   * generic model wrapper cannot choose plugin scope or bypass its checks. */
  async dispatchMcp(
    target: McpCapabilityTool,
    args: Record<string, unknown>,
    invocation: string,
    execute: (args: Record<string, unknown>) => Promise<string>,
    resultFormat: "text" | "mcp-sdk" = "text"
  ): Promise<string> {
    await this.refresh()
    if (target.pluginId) {
      this.request.store.toolOnce(
        this.request.lease,
        `hook-plugin:${digest(target.pluginId)}`,
        { pluginId: target.pluginId },
        () => true
      )
      this.scope.activatePlugin(target.pluginId)
    }
    return this.dispatchCheckedTool(
      target.toolId,
      args,
      `connector:${invocation}`,
      `mcp:${target.capabilityId}`,
      execute,
      { pluginId: target.pluginId },
      resultFormat === "mcp-sdk" ? appendBotMcpHookFeedback : undefined
    )
  }

  async dispatchResource(
    pluginId: string | undefined,
    args: Record<string, unknown>,
    invocation: string,
    execute: (args: Record<string, unknown>) => Promise<string>
  ): Promise<string> {
    await this.refresh()
    if (pluginId) {
      this.request.store.toolOnce(
        this.request.lease,
        `hook-plugin:${digest(pluginId)}`,
        { pluginId },
        () => true
      )
      this.scope.activatePlugin(pluginId)
    }
    return this.dispatchCheckedTool(
      "read_connector_resource",
      args,
      `resource:${invocation}`,
      "host:read_connector_resource",
      execute,
      { pluginId }
    )
  }

  async dispatchNative(
    name: string,
    args: Record<string, unknown>,
    invocation: string,
    execute: (args: Record<string, unknown>) => Promise<string>
  ): Promise<string> {
    await this.refresh()
    return this.dispatchCheckedTool(
      name,
      args,
      invocation,
      `host:${name}`,
      execute,
      undefined,
      appendNativeHookFeedback
    )
  }

  private async dispatchCheckedTool(
    name: string,
    args: Record<string, unknown>,
    invocation: string,
    target: string,
    execute: (args: Record<string, unknown>) => Promise<string>,
    context?: Pick<HookContext, "pluginId">,
    formatFeedback?: (serialized: string, feedback: string) => string
  ): Promise<string> {
    const middleware = this.middleware(context, target)
    const result: unknown = await middleware.wrapToolCall!(
      {
        toolCall: { name, id: invocation, args },
        tool: undefined,
        state: { messages: [] },
        runtime: { signal: this.request.signal }
      },
      async (call) => {
        const content = await execute(call.toolCall.args)
        return new ToolMessage({
          // The shared middleware preserves block boundaries when appending
          // feedback. Never parse a JSON prefix out of arbitrary returned text.
          content: formatFeedback ? [{ type: "text", text: content }] : content,
          tool_call_id: invocation,
          name
        })
      }
    )
    if (typeof result === "string") return result
    if (ToolMessage.isInstance(result) && typeof result.content === "string") return result.content
    if (formatFeedback && ToolMessage.isInstance(result) && Array.isArray(result.content)) {
      const blocks: string[] = []
      for (const block of result.content) {
        if (block.type !== "text" || typeof block.text !== "string")
          throw new BotDomainError("hook_tool_result", "工具检查返回了无法读取的结果")
        blocks.push(block.text)
      }
      if (blocks.length) return formatFeedback(blocks[0], blocks.slice(1).join("\n\n"))
    }
    throw new BotDomainError("hook_tool_result", "工具检查返回了无法读取的结果")
  }

  completionRevision(invocation: string, event: "PostSkillUse" | "Stop" = "Stop"): number {
    const { store, lease, run } = this.request
    // Preserve Stop receipts written by earlier Host builds.
    const prefix = event === "Stop" ? "hook-stop-review" : "hook-post-skill-review"
    return store.toolOnce(
      lease,
      `${prefix}:${digest(invocation).slice(0, 24)}`,
      { invocation },
      () => {
        const count = store.db.exec("SELECT COUNT(*) FROM bot_receipts WHERE nonce LIKE ?", [
          `tool:${run.id}:${prefix}:%`
        ])[0]?.values[0]?.[0]
        return Number(count ?? 0) + 1
      }
    )
  }

  private async execute(
    input: Parameters<NonNullable<HookRunnerServices["execute"]>>[0]
  ): Promise<HookResult> {
    const { store, lease, run, bot, signal } = this.request
    const hook = input.hook as OwnedHook
    if (
      this.request.worktree &&
      hook.configured &&
      hook.owner !== "workspace" &&
      hook.type !== "http" &&
      hook.type !== "prompt"
    )
      throw new BotDomainError(
        "hook_worktree_source",
        "隔离子任务不能在外部全局或插件目录执行命令 Hook，请将此检查配置到项目目录"
      )
    const identity = digest([run.id, hook.skillId, hook.skillVersion, hook.id, input.event])
    const role = store.workflowChildren.metadata(run.id)?.input
    if (
      role &&
      hook.type !== "prompt" &&
      ((role.shellAccess !== undefined && role.shellAccess !== "full") ||
        !botWorkflowChildAllows(role, hook.type === "http" ? "call_connector_tool" : "execute"))
    )
      throw new BotDomainError(
        "workflow_child_hook",
        "受限子任务不能通过技能 Hook 执行命令或 HTTP 请求，请由父任务处理"
      )
    const invocation = input.context.toolCallId ?? input.context.turnId
    if (!invocation) throw new BotDomainError("hook_call_identity", "Hook 缺少稳定任务标识")
    const id = `hook:${identity}:${digest(invocation).slice(0, 24)}`
    const action = {
      hook: {
        name: hook.skillName,
        event: input.event,
        type: hook.type ?? "command",
        invocation,
        command: hook.command ?? null,
        shell: hook.shell ?? null,
        url: hook.url ?? null,
        policy: hook.prompt ?? null,
        model: hook.model ?? hook.modelId ?? bot.modelRef ?? this.snapshot.defaultRef,
        cwd: hook.hookSourceType === "workspace" ? bot.workspacePath : hook.hookSourceRoot,
        workspacePath: bot.workspacePath,
        sandbox: botShellSandboxName(this.snapshot.execution),
        inputPreview: input.payload.slice(0, 24_000),
        inputCharacters: input.payload.length,
        inputDigest: digest(input.payload),
        source: hook.skillId,
        version: hook.skillVersion,
        configuration: digest(hook)
      }
    }
    store.hookNotifications.registerAction(lease, id, action)
    store.toolOnce(lease, id, action, () => true)
    const prior = store.effectResult(lease, id, action)
    if (prior) {
      if (prior.status !== "succeeded" || !prior.result)
        throw new BotDomainError("effect_requires_review", "Hook 已有不确定结果，不能自动重复")
      return receipt.parse(JSON.parse(prior.result))
    }
    if (hook.type !== "prompt" && hook.type !== "http") this.shell.assertAvailable()
    const recheck = async () => {
      await this.current()
      if (!hook.configured) store.externalSkills.source(bot.id, hook.skillId, hook.skillVersion)
    }
    const encoded = await this.approve(
      id,
      action,
      async () => {
        await recheck()
        let result: HookResult
        if (hook.type === "prompt") {
          result = await executePromptHook(hook, input.context, input.event)
          if (result.stderr)
            throw new BotDomainError(
              "hook_model_uncertain",
              "模型 Hook 未取得有效判定，请核对模型配置后重试"
            )
        } else if (hook.type === "http") {
          result = await executeHttpHook(hook, input.payload, input.timeoutMs, { signal, env: {} })
          if (result.stderr)
            throw new BotDomainError(
              "hook_http_uncertain",
              "HTTP Hook 未取得确定结果，请核对服务端处理情况"
            )
        } else {
          const execution = botExecutionConfigSchema.parse(this.snapshot.execution)
          const source = hook.configured
            ? undefined
            : store.externalSkills.source(bot.id, hook.skillId, hook.skillVersion)
          const worktree = this.request.worktree?.boundary
          const sourceRoot =
            source?.rootPath ??
            (hook.hookSourceType === "workspace" ? bot.workspacePath : hook.hookSourceRoot)
          if (!sourceRoot) throw new BotDomainError("hook_source_missing", "Hook 执行目录不存在")
          const sourceProject = await BotProjectFiles.open(sourceRoot, [dirname(this.modelFile)])
          const project = worktree
            ? await BotProjectFiles.open(worktree.workspaceRoot, [dirname(this.modelFile)])
            : sourceProject
          const cwd = worktree && source ? botWorktreeSkillRoot(worktree, source) : project.root
          const workspaceRoot = worktree
            ? project.root
            : bot.workspacePath
              ? (await BotProjectFiles.open(bot.workspacePath, [dirname(this.modelFile)])).root
              : project.root
          result = await withBotProjectMutation(workspaceRoot, async () => {
            await recheck()
            const output = await this.shell.execute(
              {
                command: hook.command ?? "",
                cwd,
                workspaceRoot,
                worktree,
                runId: run.id,
                timeoutMs: Math.min(600_000, Math.max(1000, input.timeoutMs)),
                protectedRoots: [dirname(this.modelFile)],
                execution,
                readOnly: botShellReadOnly({ execution }),
                hook: {
                  shell: hook.shell,
                  ...(worktree && source ? { source } : {}),
                  stdin: input.payload,
                  env: botHookEnvironment(input.env)
                }
              },
              signal,
              undefined,
              async (guardSignal) => {
                guardSignal.throwIfAborted()
                await recheck()
                guardSignal.throwIfAborted()
              }
            )
            if (!output.hook || output.exitCode === null || [124, 130].includes(output.exitCode))
              throw new BotDomainError("hook_interrupted", "Hook 中断或超时，请核对已产生的效果")
            return {
              exitCode: output.exitCode,
              stdout: output.hook.stdout.trim(),
              stderr: output.hook.stderr.trim(),
              blocked: output.exitCode === 2,
              ...(botShellResultSandboxName(output)
                ? { sandbox: botShellResultSandboxName(output) }
                : {})
            }
          })
        }
        await recheck()
        const encoded = JSON.stringify(receipt.parse(result))
        if (encoded.length > 120_000)
          throw new BotDomainError("hook_output_limit", "Hook 输出超出任务收据限制，请核对执行结果")
        return encoded
      },
      recheck
    )
    // Approval denial is not a Hook success and must not dispatch the target tool.
    const completed = store.effectResult(lease, id, action)
    if (!completed)
      throw new BotDomainError("hook_declined", "用户未授权此技能 Hook，相关操作未执行")
    return receipt.parse(JSON.parse(encoded))
  }
}
