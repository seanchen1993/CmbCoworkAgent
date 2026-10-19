import assert from "node:assert/strict"
import { join } from "node:path"
import type { Page } from "playwright"

/** Native app settings, with an ordinary installed plugin and no Autobiz example UI. */
export async function verifyApplicationCompletionSettings(
  page: Page,
  threadId: string,
  artifacts: string,
  pass: (name: string) => void
): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Mods settings E2E", { exact: true }).first().click()
  await page.getByRole("button", { name: "自定义设置", exact: true }).click()
  const advanced = page.getByRole("button", { name: "高级自定义", exact: true })
  if ((await advanced.getAttribute("aria-expanded")) === "false") await advanced.click()
  await page.getByRole("button", { name: "灵件管理", exact: true }).click()
  await page
    .getByRole("navigation", { name: "灵件工作区" })
    .getByRole("button", { name: "我已添加", exact: true })
    .click()
  assert.equal(await page.locator("[data-mods-locked]").count(), 0)
  const row = page.locator('[data-function-mod-id="function-commands"]')
  await row.locator("[data-completion-policy]").waitFor({ state: "attached" })
  await row.evaluate((node) => {
    for (let parent = node.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true
  })
  const form = row.locator("[data-completion-policy]")
  await form.locator(":scope > summary").click()
  await form.getByRole("button", { name: "修复后再完成", exact: true }).click()
  assert.equal(await form.getByLabel("完成模式", { exact: true }).inputValue(), "repair")
  assert(await form.getByRole("checkbox", { name: "单元测试", exact: true }).isChecked())
  assert.equal(await form.getByLabel("相对文件或目录", { exact: true }).count(), 0)
  await page.screenshot({ path: join(artifacts, "application-completion-template.png") })
  await form.getByLabel("检查范围", { exact: true }).selectOption("file")
  await form.getByLabel("相对文件或目录", { exact: true }).fill("src/orders.ts")
  for (const label of ["代码评审", "单元测试", "E2E", "Autobiz 业务验收"])
    await form.getByRole("checkbox", { name: label, exact: true }).check()
  await form.getByLabel("Feature ID", { exact: true }).fill("order-export")
  await form.locator("[data-completion-budgets] > summary").click()
  await form.getByLabel("最大修复次数", { exact: true }).fill("3")
  await form.getByLabel("最长时间（秒）", { exact: true }).fill("90")
  await form.getByLabel("模型总预算（tokens）", { exact: true }).fill("4096")
  for (const [mode, scope] of [
    ["off", "file"],
    ["report", "diff"],
    ["check", "feature"],
    ["repair", "project"]
  ]) {
    await form.getByLabel("完成模式", { exact: true }).selectOption(mode)
    await form.getByLabel("检查范围", { exact: true }).selectOption(scope)
    await form.getByRole("button", { name: "保存项目规则", exact: true }).click()
    await form.getByRole("status").waitFor()
    const saved = await page.evaluate(
      (id) => window.api.mods.completionPolicy(id, "function-commands"),
      threadId
    )
    assert.equal(saved.source, "application")
    assert.equal(saved.policy.mode, mode)
    assert.equal(saved.policy.scope, scope)
    assert.deepEqual(saved.policy.checks, ["code-review", "unit-test", "e2e", "autobiz-validator"])
    assert.equal(saved.policy.maxRepairs, 3)
    assert.equal(saved.policy.timeoutMs, 90000)
    assert.equal(saved.policy.modelTokenBudget, 4096)
  }
  const stage = form.getByLabel("自动推进阶段起点", { exact: true })
  await stage.fill("requirements_eval_in_progress")
  assert(await stage.evaluate((node: HTMLInputElement) => node.checkValidity()))
  await form.getByRole("button", { name: "保存项目规则", exact: true }).click()
  await form.getByRole("status").waitFor()
  assert.equal(
    (
      await page.evaluate(
        (id) => window.api.mods.completionPolicy(id, "function-commands"),
        threadId
      )
    ).policy.autobizStartCheckpoint,
    "requirements_eval_in_progress"
  )
  await form.getByLabel("完成模式", { exact: true }).selectOption("report")
  await form.getByRole("button", { name: "保存项目规则", exact: true }).click()
  await form.getByRole("status").waitFor()
  assert.equal(
    (
      await page.evaluate(
        (id) => window.api.mods.completionPolicy(id, "function-commands"),
        threadId
      )
    ).policy.autobizStartCheckpoint,
    undefined
  )
  assert.equal(await stage.count(), 0)
  pass(
    "explicit stage setting persists and switching to report removes automatic checkpoint mutation"
  )
  await page.screenshot({ path: join(artifacts, "application-completion-policy.png") })
  await form.getByLabel("完成模式", { exact: true }).selectOption("off")
  await form.getByRole("button", { name: "保存项目规则", exact: true }).click()
  await form.getByRole("status").waitFor()
  pass(
    "native application UI persists all four modes/scopes, selected checks and budgets without an Autobiz example"
  )
}
