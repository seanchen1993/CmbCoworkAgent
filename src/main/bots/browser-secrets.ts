import { randomUUID } from "node:crypto"
import type { Page, ElementHandle } from "playwright"
import type { BotBrowserTarget } from "../../shared/bot-computer"
import { refHandle } from "./upstream/grok-browser-actions.js"

export interface BotSecretDestination {
  token: string
  origin: string
  path: string
  field: string
}
interface Destination {
  target: BotBrowserTarget
  page: Page
  url: string
  signature: string
  element: ElementHandle<HTMLElement | SVGElement>
  expiresAt: number
}

/** Keeps the exact DOM handle in the Host; neither secrets nor handles enter checkpoints. */
export class BotBrowserSecrets {
  private readonly destinations = new Map<string, Destination>()

  async prepare(target: BotBrowserTarget, page: Page, ref: string): Promise<BotSecretDestination> {
    for (const [token, value] of this.destinations)
      if (value.expiresAt <= Date.now() || value.target.botId === target.botId)
        await this.discard(token)
    if (this.destinations.size >= 16) throw new Error("当前安全输入请求过多")
    const url = new URL(page.url())
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
      throw new Error("安全输入需要 HTTPS 网页")
    const element = await refHandle(page, ref)
    try {
      const detail = await inspect(element)
      if (!detail || !(await element.isVisible()) || !(await element.isEditable()))
        throw new Error("请选择可编辑的密码输入框")
      const token = randomUUID()
      this.destinations.set(token, {
        target: { ...target },
        page,
        url: page.url(),
        signature: detail.signature,
        element,
        expiresAt: Date.now() + 3_600_000
      })
      return { token, origin: url.origin, path: url.pathname, field: detail.label }
    } catch (error) {
      await element.dispose().catch(() => {})
      throw error
    }
  }

  target(token: string): BotBrowserTarget {
    const destination = this.destinations.get(token)
    if (!destination || destination.expiresAt <= Date.now())
      throw new Error("安全输入目标已过期，请重新请求")
    return { ...destination.target }
  }

  async fill(token: string, value: string, check: () => void, signal: AbortSignal): Promise<void> {
    const destination = this.destinations.get(token)
    if (!destination) throw new Error("安全输入目标已失效，请重新请求")
    try {
      check()
      signal.throwIfAborted()
      if (
        destination.expiresAt <= Date.now() ||
        destination.page.isClosed() ||
        destination.page.url() !== destination.url
      )
        throw new Error("changed")
      const detail = await inspect(destination.element)
      if (
        !detail ||
        detail.signature !== destination.signature ||
        !(await destination.element.isVisible()) ||
        !(await destination.element.isEditable())
      )
        throw new Error("changed")
      check()
      signal.throwIfAborted()
      await destination.element.fill(value, { timeout: 10_000 })
      check()
      signal.throwIfAborted()
    } catch {
      // Playwright call logs can quote the attempted value. Never forward them.
      throw new Error("安全填充未确认：页面、输入框或控制权可能已变化。请人工核对，勿自动重试。")
    } finally {
      await this.discard(token)
    }
  }

  async discard(token: string): Promise<void> {
    const destination = this.destinations.get(token)
    this.destinations.delete(token)
    await destination?.element.dispose().catch(() => {})
  }

  async close(): Promise<void> {
    await Promise.all([...this.destinations.keys()].map((token) => this.discard(token)))
  }

  async releaseBot(botId: string): Promise<void> {
    await Promise.all(
      [...this.destinations]
        .filter(([, value]) => value.target.botId === botId)
        .map(([token]) => this.discard(token))
    )
  }
}

function inspect(element: ElementHandle<HTMLElement | SVGElement>) {
  return element.evaluate((node) => {
    if (
      !(node instanceof HTMLInputElement) ||
      node.type !== "password" ||
      !node.isConnected ||
      node.ownerDocument !== document ||
      node.disabled ||
      node.readOnly
    )
      return null
    const label = (
      node.getAttribute("aria-label") ||
      node.labels?.[0]?.textContent ||
      node.placeholder ||
      "密码输入框"
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120)
    return {
      label,
      signature: JSON.stringify([node.id, node.name, node.type, node.autocomplete, label])
    }
  })
}
