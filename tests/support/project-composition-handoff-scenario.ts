import assert from "node:assert/strict"
import type { Page } from "playwright"

export async function runCompositionHandoffScenario(
  page: Page,
  requests: Array<{ reader: boolean; tool?: string }>
) {
  await page.getByRole("button", { name: "项目能力", exact: true }).click()
  await page.getByRole("button", { name: /添加 隔离报告流程/ }).click()
  await page.getByRole("button", { name: /添加 报告接收流程/ }).click()
  await page.getByRole("combobox", { name: /报告接收流程.*前序报告/ }).selectOption({ index: 1 })
  const goal = page.getByRole("textbox", { name: "这次要做什么" })
  const approveStage = async () => {
    await page.getByRole("region", { name: "原流程审批" }).waitFor({ timeout: 60000 })
    await page.getByRole("button", { name: "批准此阶段", exact: true }).click()
    await page.getByRole("button", { name: "确认批准", exact: true }).click()
    await page.getByRole("button", { name: "核对并恢复", exact: true }).click()
  }
  const allowTool = async () => {
    const region = page.getByRole("region", { name: "原工具操作确认" })
    await region.waitFor({ timeout: 30000 })
    await region.getByRole("button", { name: "允许本次操作", exact: true }).click()
  }
  const start = async (text: string) => {
    await goal.fill(text)
    await page.getByRole("button", { name: "检查并预览组合", exact: true }).click()
    await page.getByRole("button", { name: "确认并启动", exact: true }).click()
  }
  await start("HOST_GOAL verify isolated report HANDOFF")
  await approveStage()
  await page.getByRole("region", { name: "原工具操作确认" }).waitFor()
  assert.equal(requests.filter((item) => item.reader).length, 0)
  await allowTool()
  await approveStage()
  // read_file uses the original read path; only writing the summary needs approval.
  await allowTool()
  await page.getByText("运行过程 · 已完成", { exact: true }).waitFor({ timeout: 60000 })
  assert(requests.some((item) => item.reader && item.tool === "read_file"))
  assert(requests.some((item) => item.reader && item.tool === "write_file"))
  const readerCalls = requests.filter((item) => item.reader).length
  await start("HOST_GOAL verify isolated report HANDOFF REJECT_TOOL")
  await approveStage()
  const region = page.getByRole("region", { name: "原工具操作确认" })
  await region.waitFor({ timeout: 30000 })
  await region.getByRole("button", { name: "拒绝本次操作", exact: true }).click()
  await page.getByText("运行过程 · 执行失败", { exact: true }).waitFor({ timeout: 60000 })
  assert.equal(
    requests.filter((item) => item.reader).length,
    readerCalls,
    "A failed first flow must never start the second flow"
  )
}
