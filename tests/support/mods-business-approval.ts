import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import type { Page } from "playwright"

/** Click the existing per-operation UI; never change sandbox or persistent permissions. */
export async function approveBusinessOperation(page: Page, project: string): Promise<void> {
  const fileButton = page.getByRole("button", { name: "允许", exact: true })
  if (await fileButton.count()) {
    const text = await fileButton.evaluate(
      (element) => element.parentElement!.parentElement!.innerText
    )
    const target = /^(?:写入|编辑): (.+)$/m.exec(text)?.[1]
    const allowed = [
      "order-export.cjs",
      ".autobizdevops/features/order-export/REQUIREMENTS_EVAL.md"
    ].map((file) => resolve(join(project, file)).toLowerCase())
    assert(
      target && allowed.includes(resolve(target).toLowerCase()),
      "DEMO_FILE_APPROVAL_OUTSIDE_TASK"
    )
    await fileButton.click()
  }
  const runButton = page.getByRole("button", { name: "运行", exact: true })
  if (await runButton.count()) {
    const command = await runButton.locator("../..").locator("pre").innerText()
    assert(
      ["npm test", "npm run test", "node business.spec.cjs"].includes(command.trim()),
      "DEMO_COMMAND_APPROVAL_OUTSIDE_TASK"
    )
    await runButton.click()
  }
}
