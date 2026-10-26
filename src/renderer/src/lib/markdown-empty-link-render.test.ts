import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import {
  ChatFilePresentationContext,
  ChatFileWorkspaceContext,
  ChatPresentationContext
} from "../components/chat/chat-presentation-context"
import { StreamingMarkdown } from "../components/chat/StreamingMarkdown"

const threadState = vi.hoisted(() => ({
  workspacePath: null as string | null,
  workspaceFiles: [] as Array<{ path: string; is_dir: boolean }>
}))

vi.mock("@/lib/thread-context", () => ({
  useThreadStateSelector: (
    _threadId: string | null,
    selector: (state: typeof threadState) => unknown
  ) => selector(threadState)
}))

const WINDOWS_CASE_FILE = "【团队级-研发中台】CmbDevClaw内置浏览器的录制与回放_测试案例.xlsx"
const WINDOWS_CASE_PATH = `D:\\my-projects\\CmbCowork\\test\\${WINDOWS_CASE_FILE}`

describe("StreamingMarkdown 空链接渲染", () => {
  it.each(["report%25.md", "100%.md", "%41.md", "report%2Fv1.md"])(
    "preserves the literal inline filename %s in the native workbench",
    (name) => {
      threadState.workspacePath = "/workspace"
      try {
        const path = `/workspace/${name}`
        const html = renderToStaticMarkup(
          createElement(StreamingMarkdown, { threadId: "native-thread", children: `\`${path}\`` })
        )
        expect(html).toContain(`<a href="${path}"`)
      } finally {
        threadState.workspacePath = null
      }
    }
  )
  it("keeps literal characters in the Host root when resolving a relative href", () => {
    const present = vi.fn(({ filePath }) => createElement("span", null, filePath))
    renderToStaticMarkup(
      createElement(
        ChatPresentationContext.Provider,
        { value: "bot" },
        createElement(
          ChatFileWorkspaceContext.Provider,
          { value: { threadId: "group-files-g", workspacePath: "/group%20" } },
          createElement(
            ChatFilePresentationContext.Provider,
            { value: present },
            createElement(StreamingMarkdown, {
              threadId: "group-files-g",
              children: "[File](report.md)"
            })
          )
        )
      )
    )
    expect(present).toHaveBeenCalledWith(expect.objectContaining({ filePath: "/group%20/report.md" }))
  })
  it.each([
    ["/private/secret.md", "/group"],
    ["/group/../private/secret.md", "/group"],
    ["/group/%2e%2e/private/secret.md", "/group"],
    ["/group%20/report.md", "/group%20"],
    ["%2Fprivate%2Fsecret.md", "/group"],
    ["C:/private/secret.md", "C:/group"],
    ["C:%5Cprivate%5Csecret.md", "C:/group"],
    ["%5Cprivate%5Csecret.md", "C:/group"],
    ["file:///private/secret.md", "/group"],
    ["codex-file:///private/secret.md", "/group"]
  ])("never substitutes a group file for absolute destination %s", (href, workspacePath) => {
    const html = renderToStaticMarkup(
      createElement(
        ChatPresentationContext.Provider,
        { value: "bot" },
        createElement(
          ChatFileWorkspaceContext.Provider,
          { value: { threadId: "group-files-g", workspacePath } },
          createElement(StreamingMarkdown, {
            threadId: "group-files-g",
            children: `[File](${href})`
          })
        )
      )
    )
    expect(html).not.toContain("<a ")
    expect(html).toContain('title="文件路径暂不可预览"')
  })
  it("keeps native inline file previews while rejecting lexical traversal", () => {
    threadState.workspacePath = "/workspace"
    try {
      const html = renderToStaticMarkup(
        createElement(StreamingMarkdown, {
          threadId: "native-thread",
          children: "`/workspace/report.md` `/workspace/../private/secret.md`"
        })
      )
      expect(html.match(/<a /g)).toHaveLength(1)
      expect(html).toContain('href="/workspace/report.md"')
      expect(html).toContain(
        '<code class="streaming-markdown-inline-code">/workspace/../private/secret.md</code>'
      )
    } finally {
      threadState.workspacePath = null
    }
  })
  it("presents only standalone in-workspace Bot delivery links as cards, retaining inline and external links", () => {
    threadState.workspacePath = "/workspace"
    const present = vi.fn(({ filePath, threadId, label }) =>
      createElement("span", { "data-delivered-file": filePath, "data-thread": threadId }, label)
    )
    const text =
      "[核验 报告](</workspace/验收资料/核验 报告.md>)\n\n说明 [引用](/workspace/reference.md)\n\n[外部](/private/secret.md)\n\n[Web](https://example.com/file.md)\n\n`[sample](/workspace/code.md)`\n\n- [CSV](/workspace/明细.csv)"
    const render = (bot: boolean) =>
      renderToStaticMarkup(
        createElement(
          ChatPresentationContext.Provider,
          { value: bot ? "bot" : "default" },
          createElement(
            ChatFilePresentationContext.Provider,
            { value: present },
            createElement(StreamingMarkdown, { threadId: "delivery-thread", children: text })
          )
        )
      )
    try {
      const html = render(true)
      expect(present).toHaveBeenCalledTimes(2)
      expect(present.mock.calls.map(([file]) => file.filePath)).toEqual([
        "/workspace/验收资料/核验 报告.md",
        "/workspace/明细.csv"
      ])
      expect(html).toContain('data-thread="delivery-thread"')
      expect(html).toContain('href="/workspace/reference.md"')
      expect(html).toContain('href="https://example.com/file.md"')
      expect(html).not.toContain('href="/private/secret.md"')
      present.mockClear()
      expect(render(false)).not.toContain("data-delivered-file")
      expect(present).not.toHaveBeenCalled()
    } finally {
      threadState.workspacePath = null
    }
  })
  it("repairs spaced Bot file destinations without changing code, web links or normal chats", () => {
    threadState.workspacePath = "/workspace"
    const text =
      "[核验 报告](/workspace/验收资料/核验 报告.md) [CSV](/workspace/明细.csv)\n\n`[sample](/workspace/a b.md)`\n\n```md\n[sample](/workspace/c d.md)\n```\n\n[Web](https://example.com/a b) [Outside](/private/a b.md)"
    try {
      const render = (bot: boolean) =>
        renderToStaticMarkup(
          createElement(
            ChatPresentationContext.Provider,
            { value: bot ? "bot" : "default" },
            createElement(StreamingMarkdown, { threadId: "files", children: text })
          )
        )
      const html = render(true)
      expect(html).toContain(
        'href="/workspace/%E9%AA%8C%E6%94%B6%E8%B5%84%E6%96%99/%E6%A0%B8%E9%AA%8C%20%E6%8A%A5%E5%91%8A.md"'
      )
      expect(html).toContain('href="/workspace/%E6%98%8E%E7%BB%86.csv"')
      expect(html).not.toContain('href="/workspace/a%20b.md"')
      expect(html).not.toContain('href="/workspace/c%20d.md"')
      expect(html).not.toContain('href="https://example.com/a%20b"')
      expect(html).not.toContain('href="/private/a%20b.md"')
      expect(render(false)).toContain("[核验 报告](/workspace/验收资料/核验 报告.md)")
    } finally {
      threadState.workspacePath = null
    }
  })
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

  it("does not navigate Bot relative file links into the Electron application directory", () => {
    const html = renderToStaticMarkup(
      createElement(
        ChatPresentationContext.Provider,
        { value: "bot" },
        createElement(StreamingMarkdown, {
          threadId: "bot-thread",
          children: "[README](README.md)"
        })
      )
    )
    expect(html).not.toContain("<a ")
    expect(html).toContain("README")
    const normal = renderToStaticMarkup(
      createElement(StreamingMarkdown, {
        threadId: "normal-thread",
        children: "[README](README.md)"
      })
    )
    expect(normal).toContain('href="README.md"')
  })

  it("keeps web links and workspace absolute previews available in Bot messages", () => {
    threadState.workspacePath = "/workspace"
    try {
      const html = renderToStaticMarkup(
        createElement(
          ChatPresentationContext.Provider,
          { value: "bot" },
          createElement(StreamingMarkdown, {
            threadId: "bot-thread",
            children: "[Web](https://example.com) [File](/workspace/file.md)"
          })
        )
      )
      expect(html).toContain('href="https://example.com"')
      expect(html).toContain('href="/workspace/file.md"')
    } finally {
      threadState.workspacePath = null
    }
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
      createElement(StreamingMarkdown, {
        threadId: "thread-preview",
        children: "查看 [index.ts](/workspace/src/index.ts:12)"
      })
    )

    expect(html).toContain("index.ts")
    expect(html).toContain('<a href="/workspace/src/index.ts:12"')
    threadState.workspacePath = null
  })

  it("线程消息保留 Windows 盘符链接，交给预览链接组件解析", () => {
    threadState.workspacePath = "C:/workspace"
    const html = renderToStaticMarkup(
      createElement(StreamingMarkdown, {
        threadId: "thread-preview",
        children: String.raw`查看 [index.ts](C:\workspace\src\index.ts:12)`
      })
    )

    expect(html).toContain("index.ts")
    expect(html).toMatch(/<a href="C:(?:%5C|\\)workspace/)
    threadState.workspacePath = null
  })
})
