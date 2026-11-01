import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import { openCreatorStep } from "./creator-navigation"
import { normalizeWorkspacePathKey } from "../../src/shared/workspace-path"

/** Uses the real source-set import and exact dependency consent controls. */
export async function importLiveCreatorSourceSet(input: {
  app: ElectronApplication
  page: Page
  threadId: string
  workspace: string
  directory: string
}) {
  const { app, page, threadId, workspace } = input
  const directory = resolve(input.directory)
  const token = randomUUID()
  await app.evaluate(
    ({ dialog }, input) => {
      const state = globalThis as typeof globalThis & {
        __liveSourcePicker?: {
          token: string
          count: number
          original: typeof dialog.showOpenDialog
        }
      }
      if (state.__liveSourcePicker) throw Error("LIVE_SOURCE_PICKER_ALREADY_INSTALLED")
      const current = { token: input.token, count: 0, original: dialog.showOpenDialog }
      state.__liveSourcePicker = current
      dialog.showOpenDialog = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options?.title !== "选择含 devclaw.source-set.json 的作者源码目录")
          return Reflect.apply(current.original, dialog, args)
        if (++current.count !== 1) throw Error("LIVE_SOURCE_PICKER_REUSED")
        dialog.showOpenDialog = current.original
        return { canceled: false, filePaths: [input.directory] }
      }) as typeof dialog.showOpenDialog
    },
    { token, directory }
  )
  try {
    const visibleEntry = await page.locator('[data-app-guide="workspace"]').count()
    if (!visibleEntry) {
      const advanced = page.getByText("导入开发文件夹（开发者）", { exact: true })
      if (
        !(await advanced.evaluate((element) => (element.parentElement as HTMLDetailsElement).open))
      )
        await advanced.click()
      await page.getByRole("button", { name: "选择插件源码文件夹", exact: true }).click()
    }
    if (!visibleEntry)
      await page.getByRole("dialog", { name: "插件创作工作区", exact: true }).waitFor()
    const panel = await openCreatorStep(page, "delivery")
    const summary = panel.getByText("从源码导入", { exact: true })
    if (!(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
      await summary.click()
    const card = panel.getByRole("region", { name: "导入项目作者源码", exact: true })
    if (visibleEntry)
      await card.getByRole("button", { name: "选择插件源码文件夹", exact: true }).click()
    const status = () =>
      page.evaluate((id) => window.api.mods.development.status({ threadId: id }), threadId)
    const deadline = Date.now() + 120_000
    let current = await status()
    while (!current.sourceSet && Date.now() < deadline) {
      await page.waitForTimeout(100)
      current = await status()
    }
    assert(current.sourceSet, "LIVE_SOURCE_SET_IMPORT_REQUIRED")
    const setId = current.sourceSet.id
    for (const dependency of current.sourceSet.dependencies) {
      const block = card.locator("div.space-y-2.rounded.border.p-3").filter({
        has: page.getByText(`${dependency.name} · ${dependency.version}`, { exact: true })
      })
      assert.equal(await block.count(), 1, "LIVE_SOURCE_DEPENDENCY_CARD_AMBIGUOUS")
      await block.getByRole("button", { name: "安装此依赖", exact: true }).click()
      await block.getByRole("button", { name: "准备此依赖", exact: true }).click()
      await block.getByRole("button", { name: "确认准备依赖", exact: true }).click()
      await block
        .getByText("依赖已就绪，可以继续制作。", { exact: true })
        .waitFor({ timeout: 30000 })
      current = await status()
      assert.equal(current.sourceSet?.id, setId, "LIVE_SOURCE_SET_SCOPE_CHANGED")
      assert.equal(
        normalizeWorkspacePathKey(current.workspace),
        normalizeWorkspacePathKey(workspace),
        "LIVE_SOURCE_SET_WORKSPACE_CHANGED"
      )
    }
    current = await status()
    if (current.sourceSet?.phase !== "ready") {
      const next = card.getByRole("button", { name: "核对权限并准备模板", exact: true })
      if (await next.isVisible()) await next.click()
    }
    while (Date.now() < deadline) {
      current = await status()
      if (current.sourceSet?.phase === "ready") break
      assert.notEqual(current.sourceSet?.phase, "failed", current.sourceSet?.error)
      await page.waitForTimeout(150)
    }
    assert.equal(current.sourceSet?.phase, "ready", "LIVE_SOURCE_SET_NOT_READY")
    assert(current.projectTrial, "LIVE_SOURCE_SET_PROJECT_REQUIRED")
    return {
      directory,
      importTrigger: visibleEntry ? "native-ui-workspace" : "native-ui-empty-creator",
      setId,
      dependencies: current.sourceSet.dependencies,
      draftId: current.projectTrial.draftId,
      revision: current.projectTrial.revision,
      digest: current.projectTrial.digest
    }
  } finally {
    const count = await app.evaluate(({ dialog }, token) => {
      const state = globalThis as typeof globalThis & {
        __liveSourcePicker?: {
          token: string
          count: number
          original: typeof dialog.showOpenDialog
        }
      }
      const current = state.__liveSourcePicker
      if (!current || current.token !== token) throw Error("LIVE_SOURCE_PICKER_SCOPE_CHANGED")
      dialog.showOpenDialog = current.original
      delete state.__liveSourcePicker
      return current.count
    }, token)
    assert.equal(count, 1, "LIVE_SOURCE_NATIVE_PICKER_REQUIRED")
  }
}
