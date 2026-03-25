import { randomUUID } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { tool } from "langchain"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { z } from "zod"

const ACTIONS = [
  "launch",
  "goto",
  "click",
  "fill",
  "type",
  "press",
  "wait_for_selector",
  "text_content",
  "screenshot",
  "rag_list",
  "rag_upsert",
  "rag_delete",
  "rag_resolve",
  "set_active",
  "list_sessions",
  "close",
  "close_all"
] as const

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle", "commit"] as const
const WAIT_FOR_STATE = ["attached", "detached", "visible", "hidden"] as const
const CHANNELS = ["chrome", "chrome-beta", "msedge", "msedge-beta", "msedge-dev"] as const

interface PlaywrightSession {
  browser: Browser
  context: BrowserContext
  page: Page
  createdAt: number
  lastUsedAt: number
}

const sessions = new Map<string, PlaywrightSession>()
let activeSessionId: string | null = null

const DEFAULT_BROWSER_RAG_SEED: Record<string, string> = {
  "克难系统": "http://haha.com"
}

const playwrightSchema = z.object({
  action: z.enum(ACTIONS).describe(
    "Browser action: launch/goto/click/fill/type/press/wait_for_selector/text_content/screenshot/rag_list/rag_upsert/rag_delete/rag_resolve/set_active/list_sessions/close/close_all"
  ),
  sessionId: z.string().optional().describe(
    "Playwright session ID. Optional: if omitted, uses active session."
  ),
  url: z.string().optional().describe("Target URL for goto or optional initial URL for launch."),
  query: z.string().optional().describe(
    "Natural language target for URL RAG (e.g. '访问克难系统'). Used by rag_* actions and launch/goto resolution."
  ),
  selector: z.string().optional().describe("DOM selector used by click/fill/type/wait_for_selector/text_content."),
  text: z.string().optional().describe("Input text for fill/type."),
  key: z.string().optional().describe("Keyboard key for press, e.g. Enter, Escape, Control+A."),
  timeoutMs: z.number().int().min(1).max(180000).optional().describe(
    "Timeout in milliseconds for actions. Defaults to 30s."
  ),
  headless: z.boolean().optional().describe("Headless mode for launch. Defaults to false on desktop."),
  waitUntil: z.enum(WAIT_UNTIL).optional().describe("Navigation wait strategy for goto/launch."),
  waitForState: z.enum(WAIT_FOR_STATE).optional().describe("Selector state for wait_for_selector."),
  slowMoMs: z.number().int().min(0).max(1000).optional().describe("Slow motion delay in ms for launch."),
  channel: z.enum(CHANNELS).optional().describe(
    "Browser channel for launch. Useful on Windows when Playwright Chromium is not installed (e.g. msedge or chrome)."
  ),
  executablePath: z.string().optional().describe(
    "Custom browser executable path for launch (absolute path, or relative to workspace)."
  ),
  viewportWidth: z.number().int().min(200).max(8000).optional().describe("Browser viewport width."),
  viewportHeight: z.number().int().min(200).max(8000).optional().describe("Browser viewport height."),
  screenshotPath: z.string().optional().describe(
    "Screenshot output path. Relative paths are resolved from workspace root."
  ),
  fullPage: z.boolean().optional().describe("Whether screenshot captures full page. Defaults to true.")
})

function resolveSession(sessionId?: string): { id: string; session: PlaywrightSession } | null {
  const requested = sessionId?.trim()
  const id = requested || activeSessionId
  if (!id) return null
  const session = sessions.get(id)
  if (!session) return null
  return { id, session }
}

function buildError(message: string): string {
  return JSON.stringify({ success: false, error: message })
}

function touchSession(session: PlaywrightSession): void {
  session.lastUsedAt = Date.now()
}

function getDefaultScreenshotPath(workspacePath: string): string {
  const dir = path.join(workspacePath, ".cmbdevclaw", "playwright")
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `screenshot-${Date.now()}.png`)
}

function resolveOutputPath(workspacePath: string, screenshotPath?: string): string {
  if (!screenshotPath) return getDefaultScreenshotPath(workspacePath)
  return path.isAbsolute(screenshotPath)
    ? screenshotPath
    : path.resolve(workspacePath, screenshotPath)
}

function resolveExecutablePath(workspacePath: string, executablePath?: string): string | undefined {
  if (!executablePath) return undefined
  return path.isAbsolute(executablePath)
    ? executablePath
    : path.resolve(workspacePath, executablePath)
}

function normalizeRagText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[“”"'`]/g, "")
}

function looksLikeUrl(text: string): boolean {
  const value = text.trim()
  return /^https?:\/\//i.test(value) || /^www\./i.test(value)
}

function normalizeUrl(text: string): string {
  const value = text.trim()
  if (/^https?:\/\//i.test(value)) return value
  if (/^www\./i.test(value)) return `http://${value}`
  return value
}

function getBrowserRagFilePath(workspacePath: string): string {
  return path.join(workspacePath, "resources", "browser-playwright-rag.json")
}

function ensureBrowserRagFile(workspacePath: string): string {
  const ragPath = getBrowserRagFilePath(workspacePath)
  if (!existsSync(ragPath)) {
    mkdirSync(path.dirname(ragPath), { recursive: true })
    writeFileSync(ragPath, JSON.stringify(DEFAULT_BROWSER_RAG_SEED, null, 2), "utf-8")
  }
  return ragPath
}

function readBrowserRagMap(workspacePath: string): Record<string, string> {
  const ragPath = ensureBrowserRagFile(workspacePath)
  const fallback = { ...DEFAULT_BROWSER_RAG_SEED }
  try {
    const raw = readFileSync(ragPath, "utf-8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key === "string" && typeof value === "string") {
        result[key] = value
      }
    }
    return Object.keys(result).length > 0 ? result : fallback
  } catch {
    return fallback
  }
}

function writeBrowserRagMap(workspacePath: string, map: Record<string, string>): void {
  const ragPath = ensureBrowserRagFile(workspacePath)
  mkdirSync(path.dirname(ragPath), { recursive: true })
  writeFileSync(ragPath, JSON.stringify(map, null, 2), "utf-8")
}

function resolveUrlByRag(workspacePath: string, input: string): { url: string; matchedKey: string; direct: boolean } | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (looksLikeUrl(trimmed)) {
    return { url: normalizeUrl(trimmed), matchedKey: trimmed, direct: true }
  }

  const normalizedInput = normalizeRagText(trimmed)
  if (!normalizedInput) return null

  const ragMap = readBrowserRagMap(workspacePath)
  const sortedKeys = Object.keys(ragMap).sort((a, b) => normalizeRagText(b).length - normalizeRagText(a).length)

  for (const key of sortedKeys) {
    const normalizedKey = normalizeRagText(key)
    if (!normalizedKey) continue
    if (normalizedInput === normalizedKey || normalizedInput.includes(normalizedKey) || normalizedKey.includes(normalizedInput)) {
      return {
        url: normalizeUrl(ragMap[key]),
        matchedKey: key,
        direct: false
      }
    }
  }
  return null
}

function getMissingBrowserHelp(): string {
  if (process.platform === "win32") {
    return [
      "Windows hints:",
      "1) Launch with channel='msedge' or channel='chrome' to use installed browsers.",
      "2) Or install Playwright Chromium to workspace:",
      "   PowerShell: $env:PLAYWRIGHT_BROWSERS_PATH='.playwright-browsers'; npx playwright install chromium",
      "   CMD: set PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers && npx playwright install chromium"
    ].join("\n")
  }
  return "Run: PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npx playwright install chromium"
}

async function summarizeSession(id: string, session: PlaywrightSession): Promise<{
  sessionId: string
  url: string
  title: string
  createdAt: number
  lastUsedAt: number
  active: boolean
}> {
  let title = ""
  try {
    title = await session.page.title()
  } catch {
    title = ""
  }
  return {
    sessionId: id,
    url: session.page.url(),
    title,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    active: id === activeSessionId
  }
}

export function createPlaywrightTool(workspacePath: string) {
  const localBrowsersPath = path.join(workspacePath, ".playwright-browsers")

  return tool(
    async (input) => {
      const timeout = input.timeoutMs ?? 30_000
      const waitUntil = input.waitUntil ?? "domcontentloaded"

      try {
        switch (input.action) {
          case "launch": {
            if (existsSync(localBrowsersPath)) {
              process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsersPath
            }
            const baseLaunchOptions = {
              headless: input.headless ?? false,
              slowMo: input.slowMoMs
            }
            const resolvedExecutablePath = resolveExecutablePath(workspacePath, input.executablePath)
            const attempts: Array<{ label: string; options: Parameters<typeof chromium.launch>[0] }> = []

            if (resolvedExecutablePath) {
              attempts.push({
                label: `executablePath:${resolvedExecutablePath}`,
                options: { ...baseLaunchOptions, executablePath: resolvedExecutablePath }
              })
            } else if (input.channel) {
              attempts.push({
                label: `channel:${input.channel}`,
                options: { ...baseLaunchOptions, channel: input.channel }
              })
            } else {
              attempts.push({ label: "chromium", options: { ...baseLaunchOptions } })
              if (process.platform === "win32") {
                attempts.push({ label: "channel:msedge", options: { ...baseLaunchOptions, channel: "msedge" } })
                attempts.push({ label: "channel:chrome", options: { ...baseLaunchOptions, channel: "chrome" } })
              } else {
                attempts.push({ label: "channel:chrome", options: { ...baseLaunchOptions, channel: "chrome" } })
              }
            }

            let browser: Browser | null = null
            let launchMode = ""
            const launchErrors: string[] = []
            for (const attempt of attempts) {
              try {
                browser = await chromium.launch(attempt.options)
                launchMode = attempt.label
                break
              } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error)
                const compact = message.split("\n")[0]
                launchErrors.push(`${attempt.label}: ${compact}`)
              }
            }

            if (!browser) {
              throw new Error(
                `Failed to launch browser.\n${launchErrors.join("\n")}\n${getMissingBrowserHelp()}`
              )
            }

            const context = await browser.newContext({
              viewport: input.viewportWidth && input.viewportHeight
                ? { width: input.viewportWidth, height: input.viewportHeight }
                : undefined
            })
            const page = await context.newPage()
            const sessionId = randomUUID()
            const now = Date.now()
            sessions.set(sessionId, {
              browser,
              context,
              page,
              createdAt: now,
              lastUsedAt: now
            })
            activeSessionId = sessionId
            const navigationQuery = input.url ?? input.query
            let resolvedUrl: string | null = null
            let resolvedKey: string | null = null
            if (navigationQuery) {
              const resolved = resolveUrlByRag(workspacePath, navigationQuery)
              if (!resolved) {
                return buildError(
                  `Failed to resolve URL from '${navigationQuery}'. Add mapping with action=rag_upsert, query='<keyword>', url='<url>'. RAG file: ${getBrowserRagFilePath(workspacePath)}`
                )
              }
              resolvedUrl = resolved.url
              resolvedKey = resolved.direct ? null : resolved.matchedKey
              await page.goto(resolved.url, { waitUntil, timeout })
            }
            const title = await page.title().catch(() => "")
            return JSON.stringify({
              success: true,
              sessionId,
              launchMode,
              resolvedUrl,
              resolvedByRagKey: resolvedKey,
              url: page.url(),
              title,
              active: true
            })
          }

          case "goto": {
            const navigationQuery = input.url ?? input.query
            if (!navigationQuery) return buildError("url or query is required for goto")
            const resolved = resolveUrlByRag(workspacePath, navigationQuery)
            if (!resolved) {
              return buildError(
                `Failed to resolve URL from '${navigationQuery}'. Add mapping with action=rag_upsert, query='<keyword>', url='<url>'. RAG file: ${getBrowserRagFilePath(workspacePath)}`
              )
            }
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            const response = await target.session.page.goto(resolved.url, { waitUntil, timeout })
            touchSession(target.session)
            return JSON.stringify({
              success: true,
              sessionId: target.id,
              resolvedByRagKey: resolved.direct ? null : resolved.matchedKey,
              status: response?.status() ?? null,
              url: target.session.page.url(),
              title: await target.session.page.title().catch(() => "")
            })
          }

          case "click": {
            if (!input.selector) return buildError("selector is required for click")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            await target.session.page.click(input.selector, { timeout })
            touchSession(target.session)
            return JSON.stringify({ success: true, sessionId: target.id, action: "click", selector: input.selector })
          }

          case "fill": {
            if (!input.selector) return buildError("selector is required for fill")
            if (input.text == null) return buildError("text is required for fill")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            await target.session.page.fill(input.selector, input.text, { timeout })
            touchSession(target.session)
            return JSON.stringify({ success: true, sessionId: target.id, action: "fill", selector: input.selector })
          }

          case "type": {
            if (!input.selector) return buildError("selector is required for type")
            if (input.text == null) return buildError("text is required for type")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            await target.session.page.click(input.selector, { timeout })
            await target.session.page.type(input.selector, input.text, { timeout })
            touchSession(target.session)
            return JSON.stringify({ success: true, sessionId: target.id, action: "type", selector: input.selector })
          }

          case "press": {
            if (!input.key) return buildError("key is required for press")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            if (input.selector) {
              await target.session.page.press(input.selector, input.key, { timeout })
            } else {
              await target.session.page.keyboard.press(input.key)
            }
            touchSession(target.session)
            return JSON.stringify({ success: true, sessionId: target.id, action: "press", key: input.key, selector: input.selector ?? null })
          }

          case "wait_for_selector": {
            if (!input.selector) return buildError("selector is required for wait_for_selector")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            await target.session.page.waitForSelector(input.selector, {
              state: input.waitForState ?? "visible",
              timeout
            })
            touchSession(target.session)
            return JSON.stringify({
              success: true,
              sessionId: target.id,
              action: "wait_for_selector",
              selector: input.selector,
              state: input.waitForState ?? "visible"
            })
          }

          case "text_content": {
            if (!input.selector) return buildError("selector is required for text_content")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            const text = await target.session.page.textContent(input.selector, { timeout })
            touchSession(target.session)
            return JSON.stringify({
              success: true,
              sessionId: target.id,
              selector: input.selector,
              text: text ?? ""
            })
          }

          case "screenshot": {
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            const outPath = resolveOutputPath(workspacePath, input.screenshotPath)
            mkdirSync(path.dirname(outPath), { recursive: true })
            await target.session.page.screenshot({
              path: outPath,
              fullPage: input.fullPage ?? true
            })
            touchSession(target.session)
            return JSON.stringify({
              success: true,
              sessionId: target.id,
              path: outPath
            })
          }

          case "rag_list": {
            const ragFilePath = ensureBrowserRagFile(workspacePath)
            const ragMap = readBrowserRagMap(workspacePath)
            return JSON.stringify({
              success: true,
              ragFilePath,
              entries: ragMap
            })
          }

          case "rag_upsert": {
            if (!input.query) return buildError("query is required for rag_upsert")
            if (!input.url) return buildError("url is required for rag_upsert")
            const query = input.query.trim()
            const resolvedUrl = normalizeUrl(input.url)
            if (!query) return buildError("query cannot be empty for rag_upsert")
            if (!/^https?:\/\//i.test(resolvedUrl)) {
              return buildError("url must start with http:// or https:// (or use www.*)")
            }
            const ragMap = readBrowserRagMap(workspacePath)
            ragMap[query] = resolvedUrl
            writeBrowserRagMap(workspacePath, ragMap)
            return JSON.stringify({
              success: true,
              action: "rag_upsert",
              query,
              url: resolvedUrl,
              ragFilePath: getBrowserRagFilePath(workspacePath)
            })
          }

          case "rag_delete": {
            if (!input.query) return buildError("query is required for rag_delete")
            const query = input.query.trim()
            if (!query) return buildError("query cannot be empty for rag_delete")
            const ragMap = readBrowserRagMap(workspacePath)
            const existed = Object.prototype.hasOwnProperty.call(ragMap, query)
            if (existed) {
              delete ragMap[query]
              writeBrowserRagMap(workspacePath, ragMap)
            }
            return JSON.stringify({
              success: true,
              action: "rag_delete",
              query,
              removed: existed,
              ragFilePath: getBrowserRagFilePath(workspacePath)
            })
          }

          case "rag_resolve": {
            if (!input.query) return buildError("query is required for rag_resolve")
            const resolved = resolveUrlByRag(workspacePath, input.query)
            if (!resolved) {
              return JSON.stringify({
                success: false,
                resolved: null
              })
            }
            return JSON.stringify({
              success: true,
              query: input.query,
              resolvedUrl: resolved.url,
              direct: resolved.direct,
              matchedKey: resolved.matchedKey
            })
          }

          case "set_active": {
            if (!input.sessionId) return buildError("sessionId is required for set_active")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError(`Session not found: ${input.sessionId}`)
            activeSessionId = target.id
            touchSession(target.session)
            return JSON.stringify({ success: true, activeSessionId: target.id })
          }

          case "list_sessions": {
            const list = await Promise.all(Array.from(sessions.entries()).map(([id, session]) => summarizeSession(id, session)))
            return JSON.stringify({
              success: true,
              activeSessionId,
              sessions: list
            })
          }

          case "close": {
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session to close.")
            await target.session.context.close().catch(() => {})
            await target.session.browser.close().catch(() => {})
            sessions.delete(target.id)
            if (activeSessionId === target.id) {
              activeSessionId = sessions.keys().next().value ?? null
            }
            return JSON.stringify({
              success: true,
              closedSessionId: target.id,
              activeSessionId
            })
          }

          case "close_all": {
            const ids = Array.from(sessions.keys())
            for (const id of ids) {
              const session = sessions.get(id)
              if (!session) continue
              await session.context.close().catch(() => {})
              await session.browser.close().catch(() => {})
              sessions.delete(id)
            }
            activeSessionId = null
            return JSON.stringify({ success: true, closedSessionIds: ids, activeSessionId: null })
          }

          default:
            return buildError(`Unsupported action: ${String(input.action)}`)
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("Executable doesn't exist") || message.includes("Failed to launch browser")) {
          return buildError(`${message}`)
        }
        return buildError(message)
      }
    },
    {
      name: "browser_playwright",
      description:
        "Open and automate a real browser with Playwright. Supports launching browser sessions, navigation, clicking, typing, key presses, waiting for selectors, reading text content, screenshots, and URL RAG keyword mapping (e.g. natural language query -> URL).",
      schema: playwrightSchema
    }
  )
}
