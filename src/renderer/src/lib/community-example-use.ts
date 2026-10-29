import {
  clawIssues,
  parseClawProfile,
  type ClawApi,
  type ClawCapability,
  type ClawView
} from "../../../shared/mods/claw"
import type { CommunityExampleInstallation } from "../../../shared/mods/community-examples"
import { resolveClawComponents } from "../../../shared/mods/claw-components"
import type { ModWorkspaceStatus } from "../../../shared/mods/types"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import { proposeSparksExampleSelection, sparksExampleBaseline } from "./sparks-example-selection"
import { newClawCapability } from "./claw-capability-usage"

export interface ExampleUseApi extends Pick<ClawApi, "clawView" | "clawChange"> {
  status(threadId: string): Promise<ModWorkspaceStatus>
  globalEnabled(): Promise<boolean>
  configureGlobal(enabled: boolean): Promise<boolean>
  configure(
    threadId: string,
    enabled: boolean,
    outputPolicy: boolean,
    workspace: string
  ): Promise<unknown>
  approveFunction(
    threadId: string,
    pluginId: string,
    digest: string,
    workspace: string
  ): Promise<unknown>
}

interface Snapshot {
  status: ModWorkspaceStatus
  claw: ClawView
  global: boolean
}

export interface ExampleUseContext {
  threadId: string
  workspace: string
  assertCurrent(): void
}

export type InstalledPluginUseApi = ExampleUseApi
export type InstalledPluginUseContext = ExampleUseContext

export interface InstalledPluginUsePlan {
  kind: "installed" | "example"
  scope: { threadId: string; workspace: string }
  snapshot: Snapshot
  installation: { pluginId: string; pluginName: string; activationRequired?: boolean }
  activationRequired?: boolean
  target: { pluginId: string; name: string; digest: string }
  selection: ReturnType<typeof proposeSparksExampleSelection>
  baseline: ReturnType<typeof sparksExampleBaseline>
  capabilities: string[]
  replacements: Array<{
    previous: ClawCapability
    next?: ClawCapability
    reason: "conflict" | "version" | "components"
  }>
}

export interface ExampleUsePlan extends InstalledPluginUsePlan {
  installation: CommunityExampleInstallation
}

async function read(api: ExampleUseApi, context: ExampleUseContext): Promise<Snapshot> {
  context.assertCurrent()
  const [status, claw, global] = await Promise.all([
    api.status(context.threadId),
    api.clawView(context.threadId),
    api.globalEnabled()
  ])
  context.assertCurrent()
  if (
    !claw.applicable ||
    status.recovery ||
    normalizeWorkspacePathKey(status.workspace) !== normalizeWorkspacePathKey(context.workspace) ||
    claw.workspace !== status.workspace
  )
    throw Error("项目或会话范围已变化，请返回当前聊天后重新核对插件。")
  return { status, claw, global }
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  )
}

function signature(snapshot: Snapshot, grantedId?: string): string {
  const statuses = (rows = snapshot.status.functionMods ?? []) =>
    rows.map((row) => ({
      ...row,
      state: row.pluginId === grantedId ? "checked-grant" : row.state
    }))
  return stable({
    workspace: snapshot.status.workspace,
    usageContext: snapshot.claw.usageContext ?? "chat",
    global: snapshot.global,
    enabled: snapshot.status.enabled,
    outputPolicy: snapshot.status.outputPolicy,
    recovery: snapshot.status.recovery,
    capabilities: statuses(),
    revision: snapshot.claw.revision,
    bindingRevision: snapshot.claw.bindingRevision,
    active: snapshot.claw.active,
    profiles: snapshot.claw.profiles,
    clawCapabilities: statuses(snapshot.claw.capabilities)
  })
}

export async function prepareExampleUse(
  api: ExampleUseApi,
  context: ExampleUseContext,
  installation: CommunityExampleInstallation,
  displayTitle: string = installation.pluginName
): Promise<ExampleUsePlan> {
  return {
    ...(await prepareUse(api, context, installation, displayTitle, "example")),
    installation
  }
}

/** Read-only exact-source consent for an installed Function Mod and this chat's selection. */
export async function prepareInstalledPluginUse(
  api: InstalledPluginUseApi,
  context: InstalledPluginUseContext,
  installation: InstalledPluginUsePlan["installation"],
  displayName: string = installation.pluginName
): Promise<InstalledPluginUsePlan> {
  return prepareUse(api, context, installation, displayName, "installed")
}

async function prepareUse(
  api: ExampleUseApi,
  context: ExampleUseContext,
  installation: InstalledPluginUsePlan["installation"],
  displayTitle: string,
  kind: InstalledPluginUsePlan["kind"]
): Promise<InstalledPluginUsePlan> {
  const snapshot = await read(api, context)
  const mod = snapshot.status.functionMods?.find((row) => row.pluginId === installation.pluginId)
  if (
    !mod?.digest ||
    mod.name !== installation.pluginName ||
    (mod.state !== "ready" &&
      mod.state !== "needs-approval" &&
      !(kind === "installed" && installation.activationRequired && mod.state === "disabled"))
  )
    throw Error("插件未就绪或已禁用，请先到已安装列表核对状态。")
  const target = newClawCapability(mod, snapshot.claw.usageContext ?? "chat")
  const baseline = sparksExampleBaseline(snapshot.claw, {
    id: `${kind === "example" ? "example" : "plugin"}-base-${crypto.randomUUID()}`,
    name: kind === "example" ? "使用示例前的助手组合" : "使用插件前的助手组合"
  })
  const identity = {
    id: `${kind === "example" ? "example" : "plugin"}-${crypto.randomUUID()}`,
    name:
      kind === "example" ? `官方示例 · ${displayTitle}` : `使用插件 · ${displayTitle}`.slice(0, 80)
  }
  // Official examples retain their declared peer replacement. Arbitrary installed sources
  // have no inferred conflicts: preserve every other capability and all profile settings.
  const selection =
    kind === "example"
      ? proposeSparksExampleSelection(snapshot.claw, target, identity)
      : (() => {
          const profile = { ...structuredClone(baseline), ...identity }
          const existing = profile.capabilities.find((row) => row.pluginId === target.pluginId)
          if (
            profile.capabilities.some(
              (row) => row.name === target.name && row.pluginId !== target.pluginId
            )
          )
            throw Error("同名插件身份已变化，请调整聊天搭配后重新核对；不会替换其他来源。")
          profile.capabilities = [
            ...profile.capabilities.filter((row) => row.pluginId !== target.pluginId),
            {
              ...structuredClone(target),
              ...(existing ? { components: structuredClone(existing.components) } : {})
            }
          ]
          if (profile.capabilities.length > 8)
            throw Error("加入插件会超过 8 个能力的组合上限，请先调整聊天搭配；不会移除其他能力。")
          return {
            profile,
            removed: [] as ClawCapability[],
            alreadySelected: existing?.name === target.name && existing.digest === target.digest
          }
        })()
  const replacements: InstalledPluginUsePlan["replacements"] = selection.removed.map(
    (previous) => ({
      previous: structuredClone(previous),
      reason: "conflict"
    })
  )
  if (kind === "installed") {
    // The exact target's missing grant/enablement is what this review can repair.
    // Every unrelated selection issue still requires the original native repair flow.
    const targetIssues = clawIssues(
      {
        ...baseline,
        capabilities: baseline.capabilities.filter(
          (row) =>
            row.pluginId === target.pluginId && row.name === target.name && row.digest === target.digest
        )
      },
      snapshot.claw.capabilities
    )
    if (
      selection.alreadySelected &&
      snapshot.claw.issues.some((issue) => !targetIssues.includes(issue))
    )
      throw Error("当前聊天搭配存在待处理问题，请先调整搭配后重新核对插件。")
    const existing = baseline.capabilities.find((row) => row.pluginId === target.pluginId)
    if (existing) {
      const chosen = existing.components
      // Never silently expand an existing component choice or discard its parameters.
      let usableSelection: boolean
      try {
        usableSelection = !mod.components?.length
          ? !chosen
          : resolveClawComponents(
              mod.components,
              chosen ?? { mode: "all", ids: [], config: {} },
              snapshot.claw.usageContext ?? "chat"
            ).length > 0
      } catch {
        throw Error("此插件的已选组件、依赖或参数已变化，请先调整聊天搭配后重新核对。")
      }
      if (!usableSelection) {
        throw Error("此插件尚未选择当前场景的可用组件，请先调整聊天搭配后重新核对。")
      }
      const next = selection.profile.capabilities.find((row) => row.pluginId === target.pluginId)!
      if (
        existing.digest !== next.digest ||
        stable(existing.components) !== stable(next.components)
      )
        replacements.push({
          previous: structuredClone(existing),
          next: structuredClone(next),
          reason: existing.digest !== next.digest ? "version" : "components"
        })
    }
  }
  const reusable = (profile: InstalledPluginUsePlan["baseline"]) => {
    const content = (value: typeof profile) =>
      stable({ ...parseClawProfile(value), id: "", name: "" })
    const existing = snapshot.claw.profiles.find((row) => content(row) === content(profile))
    return structuredClone(existing ?? profile)
  }
  selection.profile = reusable(selection.profile)
  const retainedBaseline = reusable(baseline)
  const missing = (profile: typeof baseline) =>
    !snapshot.claw.profiles.some((row) => row.id === profile.id)
  const requiredProfiles =
    Number(
      !snapshot.claw.active &&
        !(kind === "installed" && selection.alreadySelected) &&
        missing(retainedBaseline)
    ) + Number(!selection.alreadySelected && missing(selection.profile))
  if (snapshot.claw.profiles.length + requiredProfiles > 24)
    throw Error(
      "助手组合已达到 24 个保存上限。可在“助手组合”选择已有组合，或调整已有组合后重新核对；此次未授权或切换。"
    )
  return {
    kind,
    scope: { threadId: context.threadId, workspace: context.workspace },
    snapshot,
    installation,
    ...(mod.state === "disabled" ? { activationRequired: true } : {}),
    target,
    capabilities: mod.capabilities,
    selection,
    baseline: retainedBaseline,
    replacements
  }
}

/** Each write is explicit and checked; failed/unknown writes are never automatically retried. */
export async function applyExampleUse(
  api: ExampleUseApi,
  context: ExampleUseContext,
  plan: ExampleUsePlan,
  progress: (message: string) => void
): Promise<void> {
  await applyInstalledPluginUse(api, context, plan, progress)
}

export interface InstalledPluginUseActivation {
  enable(): Promise<void>
  configurationReady(): Promise<boolean>
}

export type InstalledPluginUseResult =
  | { state: "ready" }
  | { state: "configuration"; plan: InstalledPluginUsePlan }

/** Each acknowledged write must match its prediction; partial/unknown results require a new plan. */
export async function applyInstalledPluginUse(
  api: InstalledPluginUseApi,
  context: InstalledPluginUseContext,
  plan: InstalledPluginUsePlan,
  progress: (message: string) => void,
  activation?: InstalledPluginUseActivation
): Promise<InstalledPluginUseResult> {
  context.assertCurrent()
  if (
    plan.scope.threadId !== context.threadId ||
    normalizeWorkspacePathKey(plan.scope.workspace) !== normalizeWorkspacePathKey(context.workspace)
  )
    throw Error("项目或会话范围已变化，请重新核对插件；未继续执行。")
  if (plan.activationRequired && !activation)
    throw Error("此插件尚未启用，请重新核对启用确认；未继续执行。")
  let expected = structuredClone(plan.snapshot)
  const verify = async (grantedId?: string) => {
    const actual = await read(api, context)
    if (signature(actual, grantedId) !== signature(expected, grantedId))
      throw Error("安装版本、授权或助手组合已变化，请重新核对插件；未继续执行。")
    expected = actual
  }
  const saveAndApply = async (profile: ExampleUsePlan["baseline"]) => {
    await verify()
    context.assertCurrent()
    const parsed = parseClawProfile(profile)
    const accept = (result: ClawView, predicted: ClawView) => {
      context.assertCurrent()
      if (
        result.workspace !== expected.status.workspace ||
        !result.applicable ||
        signature({ ...expected, claw: result }) !== signature({ ...expected, claw: predicted })
      )
        throw Error("组合写入后的状态已变化，请重新核对；不会继续覆盖当前选择。")
      expected.claw = result
    }
    const existing = expected.claw.profiles.find((row) => row.id === profile.id)
    if (existing) {
      if (stable(parseClawProfile(existing)) !== stable(parsed))
        throw Error("已保存组合的内容已变化，请重新核对；不会覆盖已有配置。")
    } else {
      const saved = await api.clawChange(context.threadId, {
        kind: "save",
        profile,
        revision: expected.claw.revision,
        workspace: expected.status.workspace
      })
      accept(saved, {
        ...expected.claw,
        revision: expected.claw.revision + 1,
        profiles: [...expected.claw.profiles, parsed]
      })
    }
    await verify()
    context.assertCurrent()
    const applied = await api.clawChange(context.threadId, {
      kind: "apply",
      id: profile.id,
      revision: expected.claw.revision,
      workspace: expected.status.workspace,
      bindingRevision: expected.claw.bindingRevision
    })
    accept(applied, {
      ...expected.claw,
      revision: expected.claw.revision + 1,
      bindingRevision: expected.claw.revision + 1,
      active: parsed
    })
    await verify()
  }
  await verify()
  if (!expected.claw.active && !(plan.kind === "installed" && plan.selection.alreadySelected)) {
    progress("正在保留当前助手组合…")
    // Freeze implicit ready selection before project-wide approval can add another provider.
    await saveAndApply(plan.baseline)
  }
  if (plan.activationRequired) {
    await verify()
    context.assertCurrent()
    await activation!.enable()
    // Catalog enablement may only change this exact target's disabled state. In particular,
    // it cannot reuse a changed workspace, composition or source as newly given consent.
    await verify(plan.target.pluginId)
    const enabled = expected.status.functionMods?.find((row) => row.pluginId === plan.target.pluginId)
    if (!enabled || !["ready", "needs-approval"].includes(enabled.state))
      throw Error("启用结果尚未确认，请重新读取；不会自动重复启用。")
    const configurationReady = await activation!.configurationReady()
    context.assertCurrent()
    await verify()
    if (!configurationReady)
      return {
        state: "configuration",
        plan: { ...plan, snapshot: expected, activationRequired: false }
      }
  }
  const current = expected.status.functionMods?.find((row) => row.pluginId === plan.target.pluginId)
  if (current?.state !== "ready") {
    progress(plan.kind === "example" ? "正在授权已确认的示例版本…" : "正在授权已确认的插件版本…")
    await verify()
    context.assertCurrent()
    await api.approveFunction(
      context.threadId,
      plan.target.pluginId,
      plan.target.digest,
      expected.status.workspace
    )
    await verify(plan.target.pluginId)
    if (
      expected.status.functionMods?.find((row) => row.pluginId === plan.target.pluginId)?.state !==
      "ready"
    )
      throw Error("授权结果尚未确认，请重新读取；不会自动重复授权。")
  }
  if (!plan.selection.alreadySelected) {
    progress("正在应用到当前聊天…")
    await saveAndApply(plan.selection.profile)
  }
  if (!expected.global) {
    progress("正在开启灵件功能…")
    await verify()
    context.assertCurrent()
    await api.configureGlobal(true)
    expected.global = true
    await verify()
  }
  if (!expected.status.enabled) {
    await verify()
    context.assertCurrent()
    await api.configure(
      context.threadId,
      true,
      expected.status.outputPolicy,
      expected.status.workspace
    )
    expected.status.enabled = true
    await verify()
  }
  const actualSelection =
    expected.claw.active ??
    (plan.kind === "installed"
      ? sparksExampleBaseline(expected.claw, {
          id: "verified-implicit",
          name: "当前默认助手组合"
        })
      : null)
  const selected = actualSelection?.capabilities.find(
    (row) => row.pluginId === plan.target.pluginId && row.digest === plan.target.digest
  )
  if (!selected) throw Error("尚未确认当前聊天使用此版本，请重新读取。")
  if (plan.kind === "installed") {
    const mod = expected.status.functionMods?.find((row) => row.pluginId === plan.target.pluginId)
    if (
      expected.claw.issues.length ||
      !mod ||
      mod.state !== "ready" ||
      (mod.components?.length &&
        !resolveClawComponents(
          mod.components,
          selected.components,
          expected.claw.usageContext ?? "chat"
        ).length)
    )
      throw Error("尚未确认当前聊天使用此版本的组件，请重新读取。")
  }
  context.assertCurrent()
  return { state: "ready" }
}

export type ExampleUsageState = "installed" | "using" | "conflict"

/** Display-only snapshot; confirmation still re-reads and validates every write. */
export async function readExampleUsage(
  api: ExampleUseApi,
  context: ExampleUseContext,
  examples: readonly import("../../../shared/mods/community-examples").CommunityExample[]
): Promise<Record<string, ExampleUsageState>> {
  const snapshot = await read(api, context)
  return Object.fromEntries(
    examples
      .filter((example) => example.installation?.state === "installed")
      .map((example) => {
        const mod = snapshot.status.functionMods?.find(
          (row) => row.pluginId === example.installation?.pluginId
        )
        if (!mod?.digest || mod.name !== example.pluginName) return [example.id, "installed"]
        try {
          const selection = proposeSparksExampleSelection(
            snapshot.claw,
            newClawCapability(mod, snapshot.claw.usageContext ?? "chat"),
            { id: "display-only", name: "display-only" }
          )
          if (selection.removed.length) return [example.id, "conflict"]
          return [
            example.id,
            selection.alreadySelected &&
            snapshot.global &&
            snapshot.status.enabled &&
            mod.state === "ready"
              ? "using"
              : "installed"
          ]
        } catch {
          return [example.id, "conflict"]
        }
      })
  )
}
