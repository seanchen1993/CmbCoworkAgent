import type { ClawCapability, ClawProfile, ClawView } from "../../../shared/mods/claw"

type View = Pick<ClawView, "active" | "capabilities">
type Identity = Pick<ClawProfile, "id" | "name">

/** Snapshot the current selection; callers own consent, freshness and all writes. */
export function sparksExampleBaseline(view: View, identity: Identity): ClawProfile {
  const profile: ClawProfile = {
    ...structuredClone(view.active ?? {}),
    ...identity,
    capabilities: structuredClone(
      view.active?.capabilities ??
        view.capabilities
          .filter((item) => item.state === "ready" && item.digest)
          .map((item) => ({ pluginId: item.pluginId, name: item.name, digest: item.digest! }))
    )
  }
  if (profile.capabilities.length > 8)
    throw Error("当前启用的灵件超过组合上限，请先到我的助手核对选择；不会自动移除其他灵件。")
  return profile
}

export function proposeSparksExampleSelection(
  view: View,
  target: ClawCapability,
  identity: Identity
): { profile: ClawProfile; removed: ClawCapability[]; alreadySelected: boolean } {
  const profile = sparksExampleBaseline(view, identity)
  const peer =
    target.name === "token-weather"
      ? "replay-theater"
      : target.name === "replay-theater"
        ? "token-weather"
        : undefined
  const removed = profile.capabilities.filter((item) => item.name === peer)
  const existing = profile.capabilities.find((item) => item.pluginId === target.pluginId)
  if (
    profile.capabilities.some(
      (item) => item.name === target.name && item.pluginId !== target.pluginId
    )
  )
    throw Error("同名灵件身份已变化，请重新读取安装记录，不能替换未经核对的版本。")
  for (const item of removed) {
    if (
      profile.completionRules?.some((rule) => rule.pluginId === item.pluginId) ||
      (profile.flow?.definition.schemaVersion === 1 &&
        profile.flow.definition.plugin === item.name) ||
      profile.flow?.definition.steps.some(
        (step) =>
          step.kind === "plugin-action" &&
          (step.pluginId === item.pluginId || step.plugin === item.name)
      )
    )
      throw Error(
        `${item.name} 仍被流程或完成规则引用，请先到我的助手调整；不会自动删除流程或规则。`
      )
  }
  profile.capabilities = [
    ...profile.capabilities.filter(
      (item) => item.pluginId !== target.pluginId && item.name !== peer
    ),
    {
      ...structuredClone(target),
      ...(existing?.components ? { components: structuredClone(existing.components) } : {})
    }
  ]
  if (profile.capabilities.length > 8)
    throw Error("加入示例会超过 8 个灵件的组合上限，请先到我的助手调整选择。")
  return {
    profile,
    removed,
    alreadySelected:
      removed.length === 0 && existing?.name === target.name && existing.digest === target.digest
  }
}
