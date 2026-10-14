import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { ClawStore } from "../mods/claw-store"
import {
  clawSourceIssues,
  parseClawProfile,
  type ClawMutation,
  type ClawView,
  type ClawSourceCatalog
} from "../../shared/mods/claw"
import type { ModsManager } from "../mods/manager"
import type { FunctionModsManager } from "../mods/v2/manager"
import { flowDigest } from "../mods/flows/store"
import { resolveClawComponents } from "../../shared/mods/claw-components"
import { validateClawActionConfig } from "../mods/v2/action-config"

export function registerClawHandlers(
  ipc: IpcMain,
  manager: ModsManager,
  functions: FunctionModsManager,
  access: {
    scope(event: IpcMainInvokeEvent, threadId: string): string
    applicable(threadId: string): boolean
    identity?(threadId: string): string
    validateModels?(refs: string[]): Promise<void>
    sources?(): Promise<ClawSourceCatalog>
    assertIdle(workspace: string, threadId: string): void
    changed(): void
  }
): void {
  const store = new ClawStore(manager.store)
  const identity = (threadId: string) =>
    access.identity?.(threadId) ?? JSON.stringify([threadId, "legacy"])
  const view = async (event: IpcMainInvokeEvent, threadId: string): Promise<ClawView> => {
    const workspace = access.scope(event, threadId)
    const applicable = access.applicable(threadId)
    const bindingIdentity = applicable ? identity(threadId) : undefined
    const capabilities = await functions.status(workspace)
    if (
      workspace !== access.scope(event, threadId) ||
      applicable !== access.applicable(threadId) ||
      (applicable && bindingIdentity !== identity(threadId))
    )
      throw Error("CLAW_SCOPE_CHANGED")
    const state = store.read(workspace)
    const binding = bindingIdentity
      ? store.selection(workspace, bindingIdentity)
      : { revision: 0, profile: null }
    return {
      ...state,
      active: binding.profile,
      bindingRevision: binding.revision,
      workspace,
      enabled: manager.isEnabled(workspace),
      applicable,
      capabilities,
      issues: functions.clawSelectionIssues(workspace, binding.profile, capabilities)
    }
  }
  ipc.handle("mods:claw-view", view)
  ipc.handle("mods:claw-sources", async (event, threadId: string) => {
    const workspace = access.scope(event, threadId)
    if (!access.applicable(threadId)) throw Error("请在支持的本地项目会话中配置我的 Claw。")
    const bindingIdentity = identity(threadId)
    if (!access.sources) throw Error("CLAW_SOURCE_CATALOG_UNAVAILABLE")
    const catalog = await access.sources()
    if (
      workspace !== access.scope(event, threadId) ||
      !access.applicable(threadId) ||
      bindingIdentity !== identity(threadId)
    )
      throw Error("CLAW_SCOPE_CHANGED")
    return catalog
  })
  ipc.handle(
    "mods:claw-change",
    async (event, input: { threadId: string; mutation: ClawMutation }) => {
      const threadId = input?.threadId
      const workspace = access.scope(event, threadId)
      const bindingIdentity = identity(threadId)
      if (!access.applicable(threadId)) throw Error("请在支持的本地项目会话中配置我的 Claw。")
      const mutation = input?.mutation
      if (
        !mutation ||
        !["save", "apply"].includes(mutation.kind) ||
        !Number.isSafeInteger(mutation.revision) ||
        mutation.revision < 0
      )
        throw Error("CLAW_INPUT_INVALID")
      if (mutation.workspace !== workspace) throw Error("项目目录已改变，请刷新 Claw 配置后重试。")
      if (
        mutation.kind === "apply" &&
        mutation.bindingRevision !== undefined &&
        (!Number.isSafeInteger(mutation.bindingRevision) ||
          store.selection(workspace, bindingIdentity).revision !== mutation.bindingRevision)
      )
        throw Error("当前对话组合已变化，请重新核对应用预览。")
      const before = store.read(workspace)
      if (before.revision !== mutation.revision) throw Error("Claw 配置已变化，请刷新后再试。")
      const profile =
        mutation.kind === "save"
          ? parseClawProfile(mutation.profile)
          : mutation.id === null
            ? null
            : before.profiles.find((item) => item.id === mutation.id)
      if (profile === undefined) throw Error("Claw 组合已移除，请刷新后重试。")
      if (profile?.flow) {
        if (flowDigest(profile.flow.definition) !== profile.flow.digest)
          throw Error("Claw 流程摘要无效，请重新选择已保存版本。")
        const selected = new Set(profile.capabilities.map((item) => item.name))
        if (
          profile.flow.definition.schemaVersion === 1 &&
          !selected.has(profile.flow.definition.plugin)
        )
          throw Error("组合必须包含绑定流程所需的插件。")
        for (const step of profile.flow.definition.steps) {
          if (!step.enabled) continue
          if (
            step.kind === "plugin-action" &&
            !profile.capabilities.some(
              (capability) =>
                capability.pluginId === step.pluginId &&
                capability.name === step.plugin &&
                capability.digest === step.digest
            )
          )
            throw Error(`${step.name} 的动作来源未加入组合，或插件版本已改变。`)
          if (
            (step.kind === "agent" || step.kind === "skill") &&
            step.modelRole &&
            !step.modelId &&
            !profile.models?.roles[step.modelRole]
          )
            throw Error(`${step.name} 缺少模型角色 ${step.modelRole} 的绑定。`)
          const source =
            step.kind === "skill"
              ? step.skill
              : step.kind === "mcp-tool"
                ? step.provider
                : undefined
          const selection = step.kind === "skill" ? profile.skills : profile.mcp
          if (
            source &&
            selection?.mode === "selected" &&
            !selection.items.some(
              (item) =>
                item.id === source.id && item.name === source.name && item.digest === source.digest
            )
          )
            throw Error(`${step.name} 的来源未加入组合，或来源版本已改变。`)
        }
      }
      const modelRefs = [
        profile?.models?.default,
        ...Object.values(profile?.models?.roles ?? {}),
        ...(profile?.flow?.definition.steps.flatMap((step) =>
          step.enabled && (step.kind === "agent" || step.kind === "skill") ? [step.modelId] : []
        ) ?? [])
      ].filter((ref): ref is string => Boolean(ref))
      if (modelRefs.length) await access.validateModels?.(modelRefs)
      const hasSelectedSources =
        profile?.skills?.mode === "selected" ||
        profile?.mcp?.mode === "selected" ||
        profile?.flow?.definition.steps.some(
          (step) => step.enabled && (step.kind === "skill" || step.kind === "mcp-tool")
        )
      if (hasSelectedSources) {
        if (!access.sources) throw Error("CLAW_SOURCE_CATALOG_UNAVAILABLE")
        const sources = await access.sources()
        const issues = [
          ...clawSourceIssues(profile?.skills, sources.skills, "Skill"),
          ...clawSourceIssues(profile?.mcp, sources.mcp, "MCP 服务")
        ]
        for (const step of profile?.flow?.definition.steps ?? []) {
          if (!step.enabled) continue
          if (step.kind === "skill")
            issues.push(
              ...clawSourceIssues(
                { mode: "selected", items: [step.skill] },
                sources.skills,
                step.name
              )
            )
          if (step.kind === "mcp-tool")
            issues.push(
              ...clawSourceIssues(
                { mode: "selected", items: [step.provider] },
                sources.mcp,
                step.name
              )
            )
        }
        if (issues.length) throw Error(issues.join("；"))
      }
      const available = await functions.status(workspace)
      if (
        workspace !== access.scope(event, threadId) ||
        bindingIdentity !== identity(threadId) ||
        !access.applicable(threadId)
      )
        throw Error("CLAW_SCOPE_CHANGED")
      const issues = functions.clawSelectionIssues(workspace, profile, available)
      if (issues.length) throw Error(issues.join("；"))
      for (const capability of profile?.capabilities ?? []) {
        const source = available.find(
          (item) =>
            item.pluginId === capability.pluginId &&
            item.name === capability.name &&
            item.digest === capability.digest
        )
        const components = resolveClawComponents(source?.components ?? [], capability.components)
        for (const component of components) {
          try {
            validateClawActionConfig(
              capability.components?.config[component.id] ?? {},
              component.configSchema
            )
          } catch {
            throw Error(`${capability.name} · ${component.name} 的组件配置不符合声明。`)
          }
        }
        if (source?.components?.length)
          for (const step of profile?.flow?.definition.steps ?? [])
            if (
              step.enabled &&
              step.kind === "plugin-action" &&
              step.pluginId === capability.pluginId &&
              !components.some((component) => component.actionIds.includes(step.actionId))
            )
              throw Error(`${step.name} 所需的组件未加入组合。`)
      }
      if (mutation.kind === "save") {
        store.write(
          workspace,
          {
            ...before,
            profiles: [...before.profiles.filter((item) => item.id !== profile!.id), profile!]
          },
          mutation.revision
        )
      } else {
        // No await between idle check, atomic state write and authority invalidation.
        if (
          mutation.bindingRevision !== undefined &&
          store.selection(workspace, bindingIdentity).revision !== mutation.bindingRevision
        )
          throw Error("当前对话组合已变化，请重新核对应用预览。")
        access.assertIdle(workspace, threadId)
        // A binding change closes only this idle conversation, never another conversation's turn.
        manager.closeFunctionThread(threadId)
        store.apply(workspace, bindingIdentity, profile, mutation.revision)
      }
      access.changed()
      return view(event, threadId)
    }
  )
}
