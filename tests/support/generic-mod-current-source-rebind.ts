import assert from "node:assert/strict"
import { isDeepStrictEqual } from "node:util"
import type { Page } from "playwright"
import type { ClawProfile } from "../../src/shared/mods/claw"
import type { FunctionPluginStatus } from "../../src/shared/mods/v2/commands"
import {
  openModsAdvancedSettings,
  openModsClawEditor,
  openModsSettings
} from "./mods-sidebar-navigation"

/** Authorize current installed bytes, then upgrade the same saved selection through its UI. */
export async function rebindGenericCompositionCurrentSources(
  page: Page,
  threadId: string,
  workspace: string,
  sources: readonly FunctionPluginStatus[],
  until: <T>(label: string, read: () => Promise<T | undefined>, limit?: number) => Promise<T>,
  record: (value: unknown) => void
): Promise<boolean> {
  assert.equal(sources.length, 2, "ONLY_THE_PRIOR_TWO_SOURCE_FIXTURE_IS_REVIEWED")
  assert.equal(new Set(sources.map((source) => source.pluginId)).size, 2)
  const before = await page.evaluate((id) => window.api.mods.clawView(id), threadId)
  assert.equal(before.workspace, workspace)
  assert(before.active && before.enabled && before.applicable)
  const original = structuredClone(before.active)
  const selected = sources.map((source) => {
    assert(source.digest)
    const item = original.capabilities.find(
      (item) => item.pluginId === source.pluginId && item.name === source.name
    )
    assert(item, "CURRENT_VERSION_REVIEW_MUST_RETAIN_ORIGINAL_SELECTION")
    return { source, item }
  })
  assert.equal(
    original.capabilities.length,
    sources.length,
    "ONLY_THE_PRIOR_TWO_SOURCE_FIXTURE_IS_REVIEWED"
  )
  assert.equal(original.flow, undefined, "COMPOSITION_RECOVERY_DOES_NOT_REWRITE_A_WORKFLOW")
  if (selected.every(({ source, item }) => source.digest === item.digest)) return false
  const recovery = page.getByRole("complementary", { name: "任务进展", exact: true })
  if (await recovery.isVisible())
    await recovery.getByRole("button", { name: "收起任务进展", exact: true }).click()
  await openModsSettings(page)
  for (const { source } of selected) {
    const current = (
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods?.find((item) => item.pluginId === source.pluginId)
    assert(
      current && current.name === source.name && current.digest === source.digest,
      "CURRENT_SOURCE_CHANGED_BEFORE_VERSION_REVIEW"
    )
    if (current.state === "ready") continue
    assert.equal(current.state, "needs-approval")
    const card = page.locator(
      `[data-mods-settings] [data-installed-mod-id=${JSON.stringify(source.pluginId)}]`
    )
    const manage = card.getByRole("button", { name: "管理", exact: true })
    if (await manage.isVisible()) await manage.click()
    const approval = card.locator(
      `[data-function-mod-id=${JSON.stringify(source.name)}] [data-native-function-approval=${JSON.stringify(source.pluginId)}]`
    )
    await approval.waitFor()
    await approval.getByText(`授权范围：${workspace}，同目录聊天共用。`, { exact: true }).waitFor()
    const details = approval.getByText("权限与版本详情", { exact: true })
    if (!(await details.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
      await details.click()
    await approval.getByText(`版本摘要：${source.digest}`, { exact: true }).waitFor()
    await approval.getByRole("button", { name: "授权以上能力", exact: true }).click()
    await until("CURRENT_INSTALLED_SOURCE_REVIEWED", async () => {
      const value = (
        await page.evaluate((id) => window.api.mods.status(id), threadId)
      ).functionMods?.find((item) => item.pluginId === source.pluginId)
      assert(
        value && value.digest === source.digest && value.name === source.name,
        "CURRENT_SOURCE_CHANGED_DURING_VERSION_REVIEW"
      )
      return value.state === "ready" ? value : undefined
    })
    const untouched = await page.evaluate((id) => window.api.mods.clawView(id), threadId)
    assert.deepEqual(
      untouched.active,
      original,
      "SOURCE_APPROVAL_MUST_NOT_REPLACE_THE_SELECTED_COMPOSITION"
    )
    assert.equal(untouched.bindingRevision, before.bindingRevision)
    record({
      phase: "current-source-native-review",
      pluginId: source.pluginId,
      digest: source.digest,
      source: "original-installed-plugin-management",
      inheritedAuthority: false
    })
  }
  await openModsAdvancedSettings(page, "搭配管理")
  const panel = page.locator("[data-claw-settings]")
  await panel.getByRole("button", { name: "配置聊天搭配", exact: true }).click()
  await openModsClawEditor(page)
  const saved = panel.getByRole("button", { name: original.name, exact: true })
  assert.equal(await saved.count(), 1, "THE_OWNED_SAVED_PROFILE_MUST_BE_UNIQUE")
  await saved.click()
  await panel.getByRole("heading", { name: "编辑当前使用的组合", exact: true }).waitFor()
  assert.equal(await panel.getByLabel("助手组合名称", { exact: true }).inputValue(), original.name)
  await panel.getByRole("button", { name: "检查灵件版本", exact: true }).click()
  await panel.getByText("新版本已写入草稿，请核对后保存并应用。", { exact: true }).waitFor()
  const beforeSave = await page.evaluate((id) => window.api.mods.clawView(id), threadId)
  assert.deepEqual(beforeSave.active, original, "CHECKING_VERSIONS_MUST_NOT_SILENTLY_APPLY")
  assert.equal(beforeSave.bindingRevision, before.bindingRevision)
  const expected: ClawProfile = structuredClone(original)
  for (const item of expected.capabilities) {
    const current = sources.find(
      (source) => source.pluginId === item.pluginId && source.name === item.name
    )
    assert(current?.digest)
    item.digest = current.digest
    for (const rule of expected.completionRules ?? [])
      if (rule.pluginId === item.pluginId) rule.digest = current.digest
  }
  const comparable = (value: ClawProfile) => JSON.parse(JSON.stringify(value))
  await panel.getByRole("button", { name: "保存组合", exact: true }).click()
  await until("CURRENT_VERSION_SAVED_WITHOUT_APPLICATION", async () => {
    const view = await page.evaluate((id) => window.api.mods.clawView(id), threadId)
    assert.deepEqual(view.active, original, "SAVING_MUST_NOT_SILENTLY_APPLY_THE_UPGRADE")
    assert.equal(view.bindingRevision, before.bindingRevision)
    const profile = view.profiles.find((profile) => profile.id === original.id)
    return profile && isDeepStrictEqual(comparable(profile), comparable(expected))
      ? view
      : undefined
  })
  await saved.locator("..").getByRole("button", { name: "应用到所选聊天", exact: true }).click()
  await panel
    .getByRole("region", { name: "应用变化预览", exact: true })
    .getByRole("button", { name: "确认应用", exact: true })
    .click()
  const applied = await until("CURRENT_SOURCES_APPLIED_TO_THE_SAME_COMPOSITION", async () => {
    const view = await page.evaluate((id) => window.api.mods.clawView(id), threadId)
    assert.equal(view.workspace, workspace)
    return view.active && isDeepStrictEqual(comparable(view.active), comparable(expected))
      ? view
      : undefined
  })
  assert(applied.enabled && applied.applicable && applied.bindingRevision > before.bindingRevision)
  record({
    phase: "original-composition-version-upgrade",
    original,
    applied: applied.active,
    oldBindingRevision: before.bindingRevision,
    bindingRevision: applied.bindingRevision,
    source: "original-check-version-save-preview-confirm-UI",
    inheritedAuthority: false
  })
  await panel.getByRole("button", { name: "去这段聊天使用", exact: true }).click()
  return true
}
