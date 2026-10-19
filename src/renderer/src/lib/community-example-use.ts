import { parseClawProfile, type ClawApi, type ClawView } from "../../../shared/mods/claw"
import type { CommunityExampleInstallation } from "../../../shared/mods/community-examples"
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

export interface ExampleUsePlan {
  snapshot: Snapshot
  installation: CommunityExampleInstallation
  target: { pluginId: string; name: string; digest: string }
  selection: ReturnType<typeof proposeSparksExampleSelection>
  baseline: ReturnType<typeof sparksExampleBaseline>
  capabilities: string[]
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
    throw Error("项目或会话范围已变化，请返回当前聊天后重新打开示例。")
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
  const snapshot = await read(api, context)
  const mod = snapshot.status.functionMods?.find((row) => row.pluginId === installation.pluginId)
  if (
    !mod?.digest ||
    mod.name !== installation.pluginName ||
    (mod.state !== "ready" && mod.state !== "needs-approval")
  )
    throw Error("示例未就绪或已在插件管理中禁用，请先到已安装列表核对状态。")
  const target = newClawCapability(mod, snapshot.claw.usageContext ?? "chat")
  const selection = proposeSparksExampleSelection(snapshot.claw, target, {
    id: `example-${crypto.randomUUID()}`,
    name: `官方示例 · ${displayTitle}`
  })
  const reusable = (profile: ExampleUsePlan["baseline"]) => {
    const content = (value: typeof profile) =>
      stable({ ...parseClawProfile(value), id: "", name: "" })
    const existing = snapshot.claw.profiles.find((row) => content(row) === content(profile))
    return structuredClone(existing ?? profile)
  }
  selection.profile = reusable(selection.profile)
  const baseline = reusable(
    sparksExampleBaseline(snapshot.claw, {
      id: `example-base-${crypto.randomUUID()}`,
      name: "使用示例前的助手组合"
    })
  )
  const missing = (profile: typeof baseline) =>
    !snapshot.claw.profiles.some((row) => row.id === profile.id)
  const requiredProfiles =
    Number(!snapshot.claw.active && missing(baseline)) +
    Number(!selection.alreadySelected && missing(selection.profile))
  if (snapshot.claw.profiles.length + requiredProfiles > 24)
    throw Error(
      "助手组合已达到 24 个保存上限。可在“助手组合”选择已有组合，或调整已有组合后重新核对；此次未授权或切换。"
    )
  return {
    snapshot,
    installation,
    target,
    capabilities: mod.capabilities,
    selection,
    baseline
  }
}

/** Each write is explicit and checked; failed/unknown writes are never automatically retried. */
export async function applyExampleUse(
  api: ExampleUseApi,
  context: ExampleUseContext,
  plan: ExampleUsePlan,
  progress: (message: string) => void
): Promise<void> {
  let expected = structuredClone(plan.snapshot)
  const verify = async (grantedId?: string) => {
    const actual = await read(api, context)
    if (signature(actual, grantedId) !== signature(expected, grantedId))
      throw Error("安装版本、授权或助手组合已变化，请重新点击示例并核对；未继续执行。")
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
  if (!expected.claw.active) {
    progress("正在保留当前助手组合…")
    // Freeze implicit ready selection before project-wide approval can add another provider.
    await saveAndApply(plan.baseline)
  }
  const current = expected.status.functionMods?.find((row) => row.pluginId === plan.target.pluginId)
  if (current?.state !== "ready") {
    progress("正在授权已确认的示例版本…")
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
  if (
    !expected.claw.active?.capabilities.some(
      (row) => row.pluginId === plan.target.pluginId && row.digest === plan.target.digest
    )
  )
    throw Error("尚未确认当前聊天使用此版本，请重新读取。")
  context.assertCurrent()
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
