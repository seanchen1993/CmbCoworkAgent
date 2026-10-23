import { randomUUID } from "node:crypto"
import type { Locator, Page } from "playwright"
import { browserTools } from "playwright/lib/mcp/browser/tools"

// Reuse the MCP handlers shipped with the application's existing Playwright.
// Do not create an MCP BrowserContext: its tab discovery, downloads and lifetime
// belong to the workbench, whereas this adapter only receives one owned Page.
interface McpTool {
  schema: { name: string; inputSchema: { parse(input: unknown): unknown } }
  handle(context: unknown, input: unknown, response: unknown): Promise<void>
}
const supportedTools = new Set([
  "browser_click",
  "browser_type",
  "browser_hover",
  "browser_drag",
  "browser_select_option",
  "browser_fill_form",
  "browser_press_key",
  "browser_wait_for",
  "browser_evaluate"
])
const tools = new Map(
  (browserTools as McpTool[])
    .filter((tool) => supportedTools.has(tool.schema.name))
    .map((tool) => [tool.schema.name, tool])
)
const CHUNK_SIZE = 24_000
type AiPage = Page & { _snapshotForAI(): Promise<{ full: string }> }

/** Page/lease-qualified handles wrap Playwright's own ARIA refs, not new selectors. */
export class OwnedPageAutomation {
  private prefix = randomUUID()
  private refs = new Map<string, string>()
  private snapshot: { id: string; text: string } | undefined

  constructor(private readonly page: Page) {
    // Includes child-frame navigation: an iframe's old refs must not address its
    // replacement document. The host also invalidates on human control changes.
    page.on("framenavigated", () => this.invalidate())
    page.on("close", () => this.invalidate())
  }

  invalidate(): void {
    this.prefix = randomUUID()
    this.refs.clear()
    this.snapshot = undefined
  }

  async observe(cursor?: string): Promise<{
    content: string
    truncated: boolean
    nextCursor?: string
  }> {
    if (cursor) {
      const [id, rawOffset, extra] = cursor.split(":")
      const offset = Number(rawOffset)
      if (
        !this.snapshot ||
        id !== this.snapshot.id ||
        extra !== undefined ||
        !Number.isSafeInteger(offset) ||
        offset <= 0 ||
        offset >= this.snapshot.text.length
      )
        throw new Error("页面读取游标已失效或属于其他页面，请重新观察当前页面")
      return this.chunk(offset)
    }
    const prefix = this.prefix
    const result = await (this.page as AiPage)._snapshotForAI()
    if (prefix !== this.prefix) throw new Error("观察期间页面已改变，请重新观察")
    const refs = new Map<string, string>()
    const text = result.full.replace(/\[ref=([^\]\s]+)\]/g, (_match, raw: string) => {
      const ref = `${prefix}:${raw}`
      refs.set(ref, raw)
      return `[ref=${ref}]`
    })
    this.refs = refs
    this.snapshot = { id: randomUUID(), text }
    return this.chunk(0)
  }

  private chunk(offset: number) {
    const snapshot = this.snapshot!
    let end = Math.min(offset + CHUNK_SIZE, snapshot.text.length)
    if (end < snapshot.text.length) {
      const newline = snapshot.text.lastIndexOf("\n", end)
      if (newline > offset) end = newline + 1
    }
    const truncated = end < snapshot.text.length
    return {
      content: snapshot.text.slice(offset, end),
      truncated,
      ...(truncated ? { nextCursor: `${snapshot.id}:${end}` } : {})
    }
  }

  locator(ref: string): Locator {
    const raw = this.refs.get(ref)
    if (!raw) throw new Error("元素引用已失效或属于其他页面，请重新观察当前页面并使用返回的 ref")
    return this.page.locator(`aria-ref=${raw}`)
  }

  async run(name: string, input: Record<string, unknown>, check: () => void): Promise<string[]> {
    const tool = tools.get(name)
    if (!tool) throw new Error(`不支持的浏览器动作：${name}`)
    check()
    const results: string[] = []
    const context = {
      lookupSecret: (value: string) => ({ value, code: JSON.stringify(value) }),
      ensureTab: async () => {
        check()
        return tab
      },
      currentTabOrDie: () => {
        check()
        return tab
      }
    }
    const refLocator = async ({ ref }: { ref: string }) => {
      check()
      // A handler can issue several inputs (e.g. type, then Enter). Re-check
      // ownership and the reference between inputs, including after a dialog
      // released the host's action lock or a navigation replaced the document.
      const locator = new Proxy(this.locator(ref), {
        get: (target, property) => {
          const value = Reflect.get(target, property)
          if (typeof value !== "function") return value
          return (...args: unknown[]) => {
            check()
            this.locator(ref)
            return Reflect.apply(value, target, args)
          }
        }
      })
      return { locator, resolved: "" }
    }
    const tab = {
      page: this.page,
      context,
      modalStates: () => [], // The host arbitrates dialogs before invoking us.
      refLocator,
      refLocators: (refs: { ref: string }[]) => Promise.all(refs.map(refLocator)),
      waitForCompletion: async (operation: () => Promise<unknown>) => {
        check()
        // Locator actions retain Playwright's actionability/auto-waiting. Dialog
        // racing and cancellation are owned by the host, with one event listener.
        await operation()
      }
    }
    const response = {
      addCode: () => {},
      setIncludeSnapshot: () => {}, // The host returns the owned page's fresh snapshot.
      addError: (error: string) => {
        throw new Error(error)
      },
      addTextResult: (text: string) => {
        results.push(text)
      },
      addResult: async ({
        text,
        suggestedFilename
      }: {
        text?: string
        suggestedFilename?: string
      }) => {
        if (suggestedFilename) throw new Error("浏览器输出文件必须经过当前工作目录的文件工具")
        if (text) results.push(text)
        return {}
      }
    }
    await tool.handle(context, tool.schema.inputSchema.parse(input), response)
    return results
  }
}
