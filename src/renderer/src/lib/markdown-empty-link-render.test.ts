import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { StreamingMarkdown } from "../components/chat/StreamingMarkdown"

const threadState = vi.hoisted(() => ({
  workspacePath: null as string | null,
  workspaceFiles: [] as Array<{ path: string; is_dir: boolean }>
}))

vi.mock("@/lib/thread-context", () => ({
  useThreadStateSelector: (_threadId: string | null, selector: (state: typeof threadState) => unknown) =>
    selector(threadState)
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

  it("无反引号的工作区绝对路径链接仍可进入文件预览", () => {
    threadState.workspacePath = "/workspace"
    const html = renderToStaticMarkup(
      createElement(
        StreamingMarkdown,
        { threadId: "thread-preview", children: "查看 [index.ts](/workspace/src/index.ts:12)" }
      )
    )

    expect(html).toContain("index.ts")
    expect(html).toContain('<a href="/workspace/src/index.ts:12"')
    threadState.workspacePath = null
  })

  it("线程消息保留 Windows 盘符链接，交给预览链接组件解析", () => {
    threadState.workspacePath = "C:/workspace"
    const html = renderToStaticMarkup(
      createElement(
        StreamingMarkdown,
        {
          threadId: "thread-preview",
          children: String.raw`查看 [index.ts](C:\workspace\src\index.ts:12)`
        }
      )
    )

    expect(html).toContain("index.ts")
    expect(html).toMatch(/<a href="C:(?:%5C|\\)workspace/)
    threadState.workspacePath = null
  })
})
