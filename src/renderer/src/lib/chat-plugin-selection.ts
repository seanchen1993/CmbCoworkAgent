import {
  parseClawProfile,
  type ClawApi,
  type ClawProfile,
  type ClawView
} from "../../../shared/mods/claw"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import { sparksExampleBaseline } from "./sparks-example-selection"

type Context = { threadId: string; workspace: string; assertCurrent(): void }

const content = (profile: ClawProfile) =>
  JSON.stringify({
    ...parseClawProfile(profile),
    id: "",
    name: ""
  })

/** Remove one provider from this chat. Never disable its installation or alter other bindings. */
export async function removeChatPlugin(
  api: Pick<ClawApi, "clawView" | "clawChange">,
  context: Context,
  pluginId: string
) {
  context.assertCurrent()
  let expected = await api.clawView(context.threadId)
  const check = (view: ClawView) => {
    context.assertCurrent()
    if (
      !view.applicable ||
      view.usageContext === "project" ||
      normalizeWorkspacePathKey(view.workspace) !== normalizeWorkspacePathKey(context.workspace)
    )
      throw Error("聊天或目录已变化，请重新打开。")
  }
  check(expected)
  const profile = sparksExampleBaseline(expected, {
    id: `chat-${crypto.randomUUID()}`,
    name: "本聊天的灵件"
  })
  const target = profile.capabilities.find((item) => item.pluginId === pluginId)
  if (!target) return
  if (
    profile.completionRules?.some((rule) => rule.pluginId === pluginId) ||
    (profile.flow?.definition.schemaVersion === 1 &&
      profile.flow.definition.plugin === target.name) ||
    profile.flow?.definition.steps.some(
      (step) =>
        step.enabled &&
        step.kind === "plugin-action" &&
        (step.pluginId === pluginId || step.plugin === target.name)
    )
  )
    throw Error("此灵件仍被当前流程或完成规则使用，请先调整这些设置，再停用。")
  profile.capabilities = profile.capabilities.filter((item) => item.pluginId !== pluginId)
  const parsed = parseClawProfile(profile)
  const existing = expected.profiles.find((item) => content(item) === content(parsed))
  const chosen = existing ?? parsed
  const verify = async () => {
    const actual = await api.clawView(context.threadId)
    check(actual)
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw Error("聊天设置已变化，请重新核对后停用。")
  }
  if (!existing) {
    if (expected.profiles.length >= 24)
      throw Error("已保存组合达到上限，请先整理助手组合，再调整灵件。")
    await verify()
    const saved = await api.clawChange(context.threadId, {
      kind: "save",
      profile: chosen,
      workspace: expected.workspace,
      revision: expected.revision
    })
    check(saved)
    const predicted = {
      ...expected,
      revision: expected.revision + 1,
      profiles: [...expected.profiles, chosen]
    }
    if (JSON.stringify(saved) !== JSON.stringify(predicted))
      throw Error("保存后的聊天设置已变化，未继续切换灵件，请重新核对。")
    expected = saved
  }
  await verify()
  const applied = await api.clawChange(context.threadId, {
    kind: "apply",
    id: chosen.id,
    workspace: expected.workspace,
    revision: expected.revision,
    bindingRevision: expected.bindingRevision
  })
  check(applied)
  if (
    content(applied.active ?? { id: "missing", name: "missing", capabilities: [] }) !==
      content(chosen) ||
    applied.active === null ||
    applied.bindingRevision !== expected.revision + 1
  )
    throw Error("尚未确认停用结果，请重新核对聊天设置。")
}
