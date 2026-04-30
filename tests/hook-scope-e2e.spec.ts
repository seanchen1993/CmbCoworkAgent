/**
 * End-to-end Playwright Electron test for hook scoping.
 *
 * Drives the real built app — creates a thread, sets workspace, invokes the
 * agent with a deterministic prompt that forces tool/MCP/skill usage, then
 * inspects `.hook-scope-log/events.jsonl` to verify scoping rules:
 *
 * - Plugin hooks NEVER fire on tools used before the plugin's MCP / skill is
 *   touched. They DO fire from the moment the plugin is activated and onward
 *   (any subsequent tool inherits the plugin scope).
 * - Standalone-skill `PreToolUse` hooks fire ONLY after the skill is read; not
 *   before. They never carry plugin metadata.
 *
 * Prereqs the user is responsible for (already true on this machine):
 *  - npm run build  (out/main/index.js exists)
 *  - API key configured for the active model
 *  - manual-tests/hook-scope/plugin-hook-scope-demo plugin installed
 *  - manual-tests/hook-scope/custom-skills/scope-plain-skill installed
 *
 * Run:
 *   npx tsx tests/hook-scope-e2e.spec.ts
 */

import { _electron as electron, type ElectronApplication, type Page } from "playwright"
import { existsSync, readFileSync, rmSync } from "fs"
import path from "path"

const PROJECT_ROOT = path.resolve(__dirname, "..")
// Custom shim that re-orders Chromium flags after the entry script, since
// Electron 22 rejects `--remote-debugging-port=0` when it appears before the
// script (which is where Playwright always inserts it).
const ELECTRON_LAUNCHER =
  process.platform === "win32"
    ? path.join(PROJECT_ROOT, "tests", "support", "electron-launcher.cmd")
    : path.join(PROJECT_ROOT, "node_modules", ".bin", "electron")
const MAIN_ENTRY = path.join(PROJECT_ROOT, "out", "main", "index.js")
const LOG_DIR = path.join(PROJECT_ROOT, ".hook-scope-log")
const EVENTS_FILE = path.join(LOG_DIR, "events.jsonl")
const PLAIN_SKILL_PATH = "C:\\Users\\87624\\.cmbcoworkagent\\skills\\scope-plain-skill\\SKILL.md"
const TURN_TIMEOUT_MS = 5 * 60 * 1000

interface HookEvent {
  label: string
  hook_event_name: string
  tool_name: string
  skill_name: string
  plugin_id: string
  plugin_name: string
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`)
}

function readEvents(): HookEvent[] {
  if (!existsSync(EVENTS_FILE)) return []
  return readFileSync(EVENTS_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HookEvent)
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

function resetLog(): void {
  if (existsSync(LOG_DIR)) rmSync(LOG_DIR, { recursive: true, force: true })
}

async function runOneTurn(
  page: Page,
  threadId: string,
  message: string
): Promise<{ done: boolean; error?: string; toolCallNames: string[] }> {
  return await page.evaluate<
    { done: boolean; error?: string; toolCallNames: string[] },
    { threadId: string; message: string; timeoutMs: number }
  >(
    async ({ threadId, message, timeoutMs }) => {
      const api = (window as unknown as {
        api: {
          agent: {
            invoke: (
              threadId: string,
              message: string,
              onEvent: (event: { type: string; error?: string; toolCall?: { name?: string } }) => void,
              modelId?: string
            ) => () => void
          }
        }
      }).api

      return await new Promise((resolve) => {
        const toolCallNames: string[] = []
        const timer = window.setTimeout(() => {
          resolve({ done: false, error: "timeout", toolCallNames })
        }, timeoutMs)

        const cleanup = api.agent.invoke(threadId, message, (event) => {
          if (event.type === "tool_call" && event.toolCall?.name) {
            toolCallNames.push(event.toolCall.name)
          }
          if (event.type === "done") {
            window.clearTimeout(timer)
            try { cleanup() } catch { /* */ }
            resolve({ done: true, toolCallNames })
          }
          if (event.type === "error") {
            window.clearTimeout(timer)
            try { cleanup() } catch { /* */ }
            resolve({ done: false, error: event.error, toolCallNames })
          }
        })
      })
    },
    { threadId, message, timeoutMs: TURN_TIMEOUT_MS }
  )
}

async function main(): Promise<void> {
  log("Prereq check…")
  if (!existsSync(MAIN_ENTRY)) throw new Error(`No built output at ${MAIN_ENTRY} — run npm run build first`)
  if (!existsSync(PLAIN_SKILL_PATH)) throw new Error(`Plain skill fixture missing at ${PLAIN_SKILL_PATH}`)

  log("Resetting .hook-scope-log…")
  resetLog()

  log("Launching Electron app…")
  let app: ElectronApplication | undefined
  let exitCode = 1
  try {
    app = await electron.launch({
      executablePath: ELECTRON_LAUNCHER,
      args: [MAIN_ENTRY],
      cwd: PROJECT_ROOT,
      timeout: 60_000,
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: "1",
        ELECTRON_NO_ATTACH_CONSOLE: "1"
      }
    })

    const page = await app.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    await page.waitForFunction(() => Boolean((window as unknown as { api?: unknown }).api), {
      timeout: 30_000
    })
    log("Window ready, api bridge mounted")

    const { threadId } = await page.evaluate<{ threadId: string }, { workspace: string }>(
      async ({ workspace }) => {
        const api = (window as unknown as { api: { threads: { create: (m?: object) => Promise<{ id: string }> }; workspace: { set: (id: string, p: string) => Promise<unknown> } } }).api
        const thread = await api.threads.create({ workspacePath: workspace, model: "custom:claude" })
        await api.workspace.set(thread.id, workspace)
        return { threadId: thread.id }
      },
      { workspace: PROJECT_ROOT }
    )
    log(`Thread created: ${threadId}, workspace=${PROJECT_ROOT}`)

    // Single deterministic prompt; explicitly orders the 4 phases so we can assert scope behaviour.
    const prompt = [
      "请严格按照以下顺序，每一步都用对应工具完成，不要合并，不要跳过：",
      "1) 用 read_file 工具读取 package.json 文件的前 5 行（这一步前不应该激活任何插件或技能）。",
      `2) 调用名为 scope_echo 的 MCP 工具，参数 {"message":"phase-2"}。`,
      `3) 用 read_file 工具读取这个绝对路径：${PLAIN_SKILL_PATH.replace(/\\/g, "\\\\")}（读完即可，不要展开内容）。`,
      "4) 用 execute 工具执行命令：cmd /c echo phase-4-done",
      "全部完成后只回复一个词：done。"
    ].join("\n")

    log("Sending agent turn (this hits the real LLM)…")
    const result = await runOneTurn(page, threadId, prompt)
    log(`Turn finished. done=${result.done} error=${result.error ?? "-"} toolCalls=[${result.toolCallNames.join(", ")}]`)
    if (!result.done) throw new Error(`Agent turn did not complete: ${result.error ?? "unknown"}`)

    // Give the fire-and-forget post-hook recorder a moment to flush.
    await page.waitForTimeout(1_500)

    log("Reading hook events…")
    const events = readEvents()
    log(`Total recorded events: ${events.length}`)
    for (const ev of events) {
      log(`  ${ev.label} | event=${ev.hook_event_name} | tool=${ev.tool_name} | skill=${ev.skill_name || "-"} | plugin=${ev.plugin_name || "-"}`)
    }

    // ── Assertions ──────────────────────────────────────────────────────────
    const labelsInOrder = events.map((e) => e.label)
    const idxFirstPlugin = labelsInOrder.findIndex((l) => l === "plugin-pre-any-tool")
    const idxFirstPluginPost = labelsInOrder.findIndex((l) => l === "plugin-post-any-tool")
    assert(idxFirstPlugin >= 0, "plugin-pre-any-tool should fire at least once after scope_echo")
    assert(idxFirstPluginPost >= 0, "plugin-post-any-tool should fire at least once after scope_echo")

    const firstPluginEvent = events[idxFirstPlugin]
    assert(
      firstPluginEvent.tool_name.includes("scope_echo"),
      `first plugin pre-hook should fire on scope_echo, got tool=${firstPluginEvent.tool_name}`
    )

    // No plugin hook should be tagged with read_file BEFORE the first scope_echo.
    const earlyPluginOnReadFile = events
      .slice(0, idxFirstPlugin)
      .some((e) => e.label.startsWith("plugin-") && e.tool_name === "read_file")
    assert(!earlyPluginOnReadFile, "plugin hooks must not fire on read_file before scope_echo")

    // The plain-skill execute hooks fire AFTER the skill is read.
    const idxPlainPre = labelsInOrder.indexOf("plain-skill-tool-pre")
    const idxPlainPost = labelsInOrder.indexOf("plain-skill-tool-post")
    assert(idxPlainPre >= 0, "plain-skill-tool-pre should fire on the post-skill execute call")
    assert(idxPlainPost >= 0, "plain-skill-tool-post should fire on the post-skill execute call")
    assert(events[idxPlainPre].tool_name === "execute", `plain-skill-tool-pre should target execute tool, got ${events[idxPlainPre].tool_name}`)
    assert(
      !events[idxPlainPre].plugin_id && !events[idxPlainPre].plugin_name,
      `standalone skill hook should not carry plugin metadata; got plugin_id=${events[idxPlainPre].plugin_id} plugin_name=${events[idxPlainPre].plugin_name}`
    )

    // Plugin lifecycle hooks for the plugin's own skill (only if the agent actually read it — optional in this prompt).
    const sawPluginSkillPre = labelsInOrder.includes("plugin-pre-skill")
    if (sawPluginSkillPre) {
      log("Bonus: plugin-pre-skill also observed — full lifecycle covered.")
    }

    log("\n✅ E2E PASS — hook scoping behaves as expected end-to-end.")
    exitCode = 0
  } finally {
    if (app) await app.close().catch(() => undefined)
    process.exit(exitCode)
  }
}

main().catch((err: Error) => {
  console.error(`\n❌ ${err.stack || err.message}`)
  process.exit(1)
})
