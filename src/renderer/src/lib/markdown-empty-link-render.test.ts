import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { StreamingMarkdown } from "../components/chat/StreamingMarkdown"

vi.mock("@/lib/thread-context", () => ({
  useThreadStateSelector: () => null
}))

const WINDOWS_CASE_FILE = "【团队级-研发中台】CmbDevClaw内置浏览器的录制与回放_测试案例.xlsx"
const WINDOWS_CASE_PATH = `D:\\my-projects\\CmbCowork\\test\\${WINDOWS_CASE_FILE}`

describe("StreamingMarkdown 空链接渲染", () => {
  it("Windows 本地路径被 URL 消毒清空后渲染为普通文本，不再输出 <a>", () => {
    const html = renderToStaticMarkup(
      createElement(
        StreamingMarkdown,
        null,
        `已生成UAT测试案例Excel文件：[${WINDOWS_CASE_FILE}](${WINDOWS_CASE_PATH})`
      )
    )

    expect(html).not.toContain("<a ")
    expect(html).toContain(`<span>${WINDOWS_CASE_FILE}</span>`)
  })

  it("正常网页链接仍渲染为 <a>", () => {
    const html = renderToStaticMarkup(
      createElement(StreamingMarkdown, null, "[OpenAI](https://openai.com)")
    )

    expect(html).toContain("<a ")
    expect(html).toContain('href="https://openai.com"')
  })
})
