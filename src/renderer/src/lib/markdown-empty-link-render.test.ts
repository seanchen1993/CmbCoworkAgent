import { createElement, type ComponentProps, type MouseEvent, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StreamingMarkdown } from "../components/chat/StreamingMarkdown"
import { onOpenResourcePreview } from "./resource-preview-events"
import { onOpenResourcePanelOverlay } from "./resource-panel-overlay-events"

const threadState = vi.hoisted(() => ({
  workspacePath: null as string | null,
  workspaceFiles: [] as Array<{ path: string; is_dir: boolean }>
}))

vi.mock("@/lib/thread-context", () => ({
  useThreadStateSelector: (_threadId: string | null, selector: (state: typeof threadState) => unknown) =>
    selector(threadState)
}))

const renderedLink = vi.hoisted(() => ({ current: null as ReactElement<ComponentProps<"a">> | null }))
vi.mock("@/components/ui/tooltip", async importOriginal => {
  const actual = await importOriginal<typeof import("../components/ui/tooltip")>()
  return {
    ...actual,
    TooltipTrigger: (props: ComponentProps<typeof actual.TooltipTrigger>) => {
      renderedLink.current = props.children as ReactElement<ComponentProps<"a">>
      return createElement(actual.TooltipTrigger, props)
    }
  }
})

afterEach(() => {
  threadState.workspacePath = null
  renderedLink.current = null
  vi.unstubAllGlobals()
})

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
      // eslint-disable-next-line react/no-children-prop -- The regression explicitly supplies the native renderer children prop.
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
      // eslint-disable-next-line react/no-children-prop -- The regression explicitly supplies the native renderer children prop.
      createElement(
        StreamingMarkdown,
        {
          threadId: "thread-preview",
          children: String.raw`查看 [index.ts](C:\workspace\src\index.ts:12)`
        }
      )
    )

    expect(html).toContain("index.ts")
    // remarkWindowsFileLinks restores raw Markdown destinations and normalizes separators.
    expect(html).toContain('<a href="C:/workspace/src/index.ts:12"')
    const click = renderedLink.current?.props.onClick
    expect(click).toBeTypeOf("function")
    vi.stubGlobal("window", new EventTarget())
    const preview = vi.fn(), overlay = vi.fn()
    const stopPreview = onOpenResourcePreview(preview)
    const stopOverlay = onOpenResourcePanelOverlay(overlay)
    const preventDefault = vi.fn(), stopPropagation = vi.fn(), stopImmediatePropagation = vi.fn()
    try {
      click!({ preventDefault, stopPropagation,
        nativeEvent: { stopImmediatePropagation } } as unknown as MouseEvent<HTMLAnchorElement>)
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(stopPropagation).toHaveBeenCalledOnce()
      expect(stopImmediatePropagation).toHaveBeenCalledOnce()
      expect(overlay).toHaveBeenCalledExactlyOnceWith("preview")
      expect(preview).toHaveBeenCalledExactlyOnceWith({
        threadId: "thread-preview", filePath: "C:/workspace/src/index.ts",
        workspacePathKind: "absolute", intentId: expect.any(Number)
      })
    } finally { stopPreview(); stopOverlay() }
  })
})
