import { expect, it } from "vitest"
import { botEffectResultPreview } from "./bot-effect-result-preview"

it("shows the recorded outcome without opaque browser target and observation fields", () => {
  const raw = JSON.stringify({
    summary: "已打开 PDF 页面",
    observation: { pageId: "opaque-page", urlSha256: "private-hash" },
    target: { generation: "opaque-generation" }
  })
  expect(botEffectResultPreview(raw)).toBe("已打开 PDF 页面")
})

it("preserves plain transfer failure evidence and distinguishes absent results", () => {
  expect(botEffectResultPreview("文件下载超过 30 秒，请稍后重试")).toBe(
    "文件下载超过 30 秒，请稍后重试"
  )
  expect(botEffectResultPreview(undefined)).toBe("进程中断，未收到执行结果")
  expect(botEffectResultPreview("  \n")).toBe("进程中断，未收到执行结果")
})

it("does not expose truncated or unknown structured receipts as a readable outcome", () => {
  for (const raw of [
    '{"summary":"已打开页面","target":',
    JSON.stringify({ summary: { nested: "not a summary" }, id: "opaque" }),
    JSON.stringify([{ id: "opaque" }]),
    JSON.stringify({ summary: "large", extra: "x".repeat(9000) })
  ])
    expect(botEffectResultPreview(raw)).toBe("执行记录已保存，展开查看操作与结果")
})
