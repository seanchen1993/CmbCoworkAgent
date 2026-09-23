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
  await page.getByRole("button", { name: "自定义", exact: true }).click()
  await page.getByRole("button", { name: "Function Mods", exact: true }).click()
  const locked = page.locator("[data-mods-locked]")
  if (await locked.count()) {
    await page.getByLabel("输入管理口令解锁 Function Mods 设置").fill("admin123456")
    await page.getByRole("button", { name: "解锁设置" }).click()
  }
  const row = page.locator('[data-function-mod-id="function-commands"]')
  await row.locator("[data-completion-policy]").waitFor({ state: "attached" })
  await row.evaluate((node) => {
    for (let parent = node.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true
  })
  const form = row.locator("[data-completion-policy]")
  await form.locator(":scope > summary").click()
  await form.getByLabel("相对文件或目录", { exact: true }).fill("src/orders.ts")
  await form.getByLabel("Feature ID", { exact: true }).fill("order-export")
  await form.getByLabel("最大修复次数", { exact: true }).fill("3")
  await form.getByLabel("最长时间（秒）", { exact: true }).fill("90")
  await form.getByLabel("模型总预算（tokens）", { exact: true }).fill("4096")
  for (const label of ["代码评审", "单元测试", "E2E", "Autobiz validator"])
    await form.getByRole("checkbox", { name: label, exact: true }).check()
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
  await page.screenshot({ path: join(artifacts, "application-completion-policy.png") })
  await form.getByLabel("完成模式", { exact: true }).selectOption("off")
  await form.getByRole("button", { name: "保存项目规则", exact: true }).click()
  await form.getByRole("status").waitFor()
  pass(
    "native application UI persists all four modes/scopes, selected checks and budgets without an Autobiz example"
  )
}
