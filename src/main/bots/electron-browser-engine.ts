import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { app } from "electron"
import type { Browser, Page } from "playwright"
import type { BotBrowserEngine } from "./browser-engine"

/** Reuses this installation's Electron/Chromium. No browser download or application-wide CDP connection. */
export async function startElectronBotBrowser(profile: string): Promise<BotBrowserEngine> {
  await mkdir(profile, { recursive: true })
  const environment: NodeJS.ProcessEnv = { ...process.env, CMB_BOT_BROWSER_PROFILE: profile }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.NODE_OPTIONS
  const child = spawn(
    process.execPath,
    [...(!app.isPackaged ? [join(__dirname, "index.js")] : []), "--cmb-bot-browser-host"],
    { env: environment, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true }
  )
  let browser: Browser | undefined,
    sequence = 0,
    closed = false
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const fail = (error: Error) => {
    closed = true
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }
  child.on("exit", () => fail(new Error("Bot 浏览器已退出，请重新打开")))
  child.on("error", fail)
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return
    const reply = message as { id?: number; value?: unknown; error?: string }
    if (typeof reply.id !== "number") return
    const request = pending.get(reply.id)
    if (!request) return
    pending.delete(reply.id)
    clearTimeout(request.timer)
    if (reply.error) request.reject(new Error(reply.error))
    else request.resolve(reply.value)
  })
  const call = (
    action: "create" | "show" | "hide" | "get-title",
    targetId?: string
  ): Promise<unknown> => {
    if (closed || !child.connected) return Promise.reject(new Error("Bot 浏览器未连接"))
    if (pending.size >= 16) return Promise.reject(new Error("浏览器请求过多，请稍候"))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error("Bot 浏览器响应超时"))
      }, 15_000)
      pending.set(id, { resolve, reject, timer })
      child.send({ id, action, targetId }, (error) => {
        if (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      })
    })
  }
  const close = async () => {
    if (child.connected) child.send({ id: ++sequence, action: "quit" }, () => {})
    const force = setTimeout(() => child.kill(), 4000)
    try {
      await exited
      await browser?.close().catch(() => {})
    } finally {
      clearTimeout(force)
      fail(new Error("Bot 浏览器已关闭"))
    }
  }
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let tail = "",
        ready = false,
        url: string | undefined
      const cleanup = () => {
        clearTimeout(timer)
        child.stderr?.off("data", data)
        child.off("message", message)
        child.off("exit", exit)
        child.off("error", error)
      }
      const check = () => {
        if (ready && url) {
          cleanup()
          resolve(url)
        }
      }
      const data = (chunk: Buffer) => {
        tail = (tail + chunk.toString("utf8")).slice(-4096)
        const match =
          /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-zA-Z0-9-]+)/.exec(
            tail
          )
        if (match) url = match[1]
        check()
      }
      const message = (value: unknown) => {
        if (value && typeof value === "object" && (value as { ready?: unknown }).ready === true) {
          ready = true
          check()
        }
      }
      const exit = () => {
        cleanup()
        reject(new Error("Bot 浏览器启动失败"))
      }
      const error = (cause: Error) => {
        cleanup()
        reject(cause)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error("Bot 浏览器启动超时"))
      }, 20_000)
      child.stderr?.on("data", data)
      child.on("message", message)
      child.once("exit", exit)
      child.once("error", error)
    })
    // Keep stderr drained without retaining web contents or logs in memory.
    child.stderr?.resume()
    const { chromium } = await import("playwright")
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 })
    const context = browser.contexts()[0]
    if (!context) throw new Error("Bot 浏览器上下文不可用")
    const identities = new WeakMap<Page, string>()
    const targetOf = async (page: Page): Promise<string> => {
      const cached = identities.get(page)
      if (cached) return cached
      const session = await context.newCDPSession(page)
      try {
        const { targetInfo } = await session.send("Target.getTargetInfo")
        identities.set(page, targetInfo.targetId)
        return targetInfo.targetId
      } finally {
        await session.detach()
      }
    }
    return {
      context,
      async createPage() {
        const result = (await call("create")) as { targetId: string }
        const deadline = Date.now() + 10_000
        do {
          for (const page of context.pages()) {
            if (!page.isClosed() && (await targetOf(page)) === result.targetId) return page
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        } while (!closed && Date.now() < deadline)
        throw new Error("未能绑定 Bot 浏览器页面")
      },
      async getTitle(page) {
        return (await call("get-title", await targetOf(page))) as string
      },
      async show(page) {
        await call("show", await targetOf(page))
      },
      async hide() {
        await call("hide")
      },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
