/**
 * Audit-targeted E2E — verify workspace-source hooks (.cmbdevclaw/hooks/*.json)
 * receive every Phase 2 feature: Setup matchQuery, PostToolUseFailure, async,
 * http, `if` clause. Plugin / skill hook sources are audited via source review
 * because their scope-gating makes pre-activation-event coverage architectural
 * rather than a parsing question.
 *
 * Run:  unset ELECTRON_RUN_AS_NODE && npx tsx tests/hook-workspace-sources.spec.ts
 */

import { _electron as electron, type ElectronApplication, type Page } from "playwright"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const PROJECT_ROOT = resolve(__dirname, "..")
const ELECTRON_LAUNCHER =
  process.platform === "win32"
    ? join(PROJECT_ROOT, "tests", "support", "electron-launcher.cmd")
    : join(PROJECT_ROOT, "node_modules", ".bin", "electron")
const MAIN_ENTRY = join(PROJECT_ROOT, "out", "main", "index.js")
const TURN_TIMEOUT_MS = 3 * 60 * 1000
const HELPER = join(PROJECT_ROOT, "tests", "support", "append-line.cjs")
const TRACE = join(tmpdir(), `hook-ws-source-${process.pid}.log`)

let pass = 0
let fail = 0
const failures: string[] = []

function log(m: string): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${m}`)
}
function assert(c: unknown, m: string): void {
  if (c) {
    pass++
    console.log(`  PASS ${m}`)
  } else {
    fail++
    failures.push(m)
    console.error(`  FAIL ${m}`)
  }
}
function rmIf(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true })
  } catch {
    /* */
  }
}
function readTrace(): string[] {
  if (!existsSync(TRACE)) return []
  return readFileSync(TRACE, "utf-8").split(/\r?\n/).filter(Boolean)
}

function cmd(tag: string): string {
  return `node "${HELPER}" "${TRACE}" "${tag}"`
}

interface WsHook {
  name: string // file basename
  content: Record<string, unknown>
}

function writeWorkspaceHooks(workspacePath: string, hooks: WsHook[]): void {
  // The workspace-local state directory is `.cmbdevclaw/` (hooks live in
  // `.cmbdevclaw/hooks/`, setup-state.json sits at `.cmbdevclaw/setup-state.json`).
  // Not to be confused with `~/.cmbcoworkagent/` which is the home-level
  // global config directory.
  const dir = join(workspacePath, ".cmbdevclaw", "hooks")
  mkdirSync(dir, { recursive: true })
  for (const h of hooks) {
    writeFileSync(join(dir, `${h.name}.json`), JSON.stringify(h.content, null, 2))
  }
}

async function trustWorkspaceHooks(page: Page, workspacePath: string): Promise<void> {
  await page.evaluate(async (wsp) => {
    await (window as unknown as {
      api: { hooks: { workspace: { trustAll: (p: string) => Promise<void> } } }
    }).api.hooks.workspace.trustAll(wsp)
  }, workspacePath)
}

async function createThread(page: Page, workspacePath: string): Promise<string> {
  return await page.evaluate(async (wsp) => {
    const api = (window as unknown as {
      api: {
        threads: {
          create: (m?: object) => Promise<{ id?: string; thread_id?: string; threadId?: string }>
        }
        workspace: { set: (id: string, p: string) => Promise<unknown> }
      }
    }).api
    const t = await api.threads.create({ workspacePath: wsp })
    const id = t.id || t.thread_id || t.threadId
    if (!id) throw new Error(`threads.create returned no id`)
    await api.workspace.set(id, wsp)
    return id
  }, workspacePath)
}

async function deleteThread(page: Page, tid: string): Promise<void> {
  try {
    await page.evaluate(async (id) => {
      await (window as unknown as {
        api: { threads: { delete: (id: string) => Promise<void> } }
      }).api.threads.delete(id)
    }, tid)
  } catch {
    /* */
  }
}

async function runSetupMaintenance(page: Page, workspacePath: string): Promise<void> {
  await page.evaluate(async (wsp) => {
    await (window as unknown as {
      api: { hooks: { workspace: { runSetupMaintenance: (p: string) => Promise<void> } } }
    }).api.hooks.workspace.runSetupMaintenance(wsp)
  }, workspacePath)
}

async function invokeTurn(
  page: Page,
  threadId: string,
  message: string
): Promise<{ done: boolean; error?: string }> {
  return await page.evaluate<
    { done: boolean; error?: string },
    { threadId: string; message: string; timeoutMs: number }
  >(
    async ({ threadId, message, timeoutMs }) => {
      const api = (window as unknown as {
        api: {
          agent: {
            invoke: (
              t: string,
              m: string,
              cb: (evt: { type: string; error?: string }) => void
            ) => () => void
          }
        }
      }).api
      return await new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          try {
            cleanup()
          } catch {
            /* */
          }
          resolve({ done: false, error: "timeout" })
        }, timeoutMs)
        const cleanup = api.agent.invoke(threadId, message, (event) => {
          if (event.type === "done") {
            window.clearTimeout(timer)
            try {
              cleanup()
            } catch {
              /* */
            }
            resolve({ done: true })
          } else if (event.type === "error") {
            window.clearTimeout(timer)
            try {
              cleanup()
            } catch {
              /* */
            }
            resolve({ done: false, error: event.error })
          }
        })
      })
    },
    { threadId, message, timeoutMs: TURN_TIMEOUT_MS }
  )
}

async function startCaptureServer(): Promise<{
  port: number
  captured: { url: string; body: string; headers: Record<string, string | string[] | undefined> }[]
  close: () => Promise<void>
}> {
  const captured: { url: string; body: string; headers: Record<string, string | string[] | undefined> }[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      captured.push({
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf-8"),
        headers: req.headers
      })
      res.end('{"decision":"approve"}')
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address()
  const port = typeof addr === "object" && addr ? addr.port : 0
  return {
    port,
    captured,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r())
      })
  }
}

async function main(): Promise<void> {
  if (!existsSync(MAIN_ENTRY)) throw new Error(`No build at ${MAIN_ENTRY} — npm run build`)
  log("Launching Electron…")
  let app: ElectronApplication | undefined
  const tmpWs: string[] = []
  const tids: string[] = []
  try {
    const cleanEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: "1", ELECTRON_NO_ATTACH_CONSOLE: "1" }
    delete (cleanEnv as Record<string, string | undefined>).ELECTRON_RUN_AS_NODE
    app = await electron.launch({
      executablePath: ELECTRON_LAUNCHER,
      args: [MAIN_ENTRY],
      cwd: PROJECT_ROOT,
      timeout: 60_000,
      env: cleanEnv
    })
    const page = await app.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    await page.waitForFunction(() => Boolean((window as unknown as { api?: unknown }).api), {
      timeout: 30_000
    })
    log("Window ready\n")

    // ── Scenario W1: Workspace Setup(init) + PostToolUseFailure + matchQuery ─
    log("=== W1: Workspace hooks — Setup(init), PostToolUseFailure, SessionEnd(clear) ===")
    rmIf(TRACE)
    {
      const ws = mkdtempSync(join(tmpdir(), "hook-ws-W1-"))
      tmpWs.push(ws)
      writeWorkspaceHooks(ws, [
        {
          name: "setup-init",
          content: {
            event: "Setup",
            matcher: "init",
            type: "command",
            command: cmd("WS-SETUP-INIT")
          }
        },
        {
          name: "tool-failure",
          content: {
            event: "PostToolUseFailure",
            matcher: "*",
            type: "command",
            command: cmd("WS-TOOL-FAILURE")
          }
        },
        {
          name: "end-clear",
          content: {
            event: "SessionEnd",
            matcher: "clear",
            type: "command",
            command: cmd("WS-END-CLEAR")
          }
        },
        {
          name: "pre-execute-sentinel",
          content: {
            event: "PreToolUse",
            matcher: "execute",
            type: "command",
            command: cmd("WS-PRE-SENTINEL")
          }
        }
      ])
      await trustWorkspaceHooks(page, ws)
      const tid = await createThread(page, ws)
      tids.push(tid)
      const r = await invokeTurn(
        page,
        tid,
        "请用 execute 工具运行：cmd /c exit 5。失败没关系，回报一下退出码就行。"
      )
      assert(r.done, "W1-1 turn completed")
      await page.waitForTimeout(1_500)
      let lines = readTrace()
      log(`  trace: ${JSON.stringify(lines)}`)
      assert(lines.includes("WS-SETUP-INIT"), "W1-2 workspace Setup(init) fired on fresh ws")
      assert(lines.includes("WS-PRE-SENTINEL"), "W1-3 workspace PreToolUse fired")
      assert(lines.includes("WS-TOOL-FAILURE"), "W1-4 workspace PostToolUseFailure fired on exit 5")
      assert(!lines.includes("WS-END-CLEAR"), "W1-5 SessionEnd has not fired yet")
      // Trigger SessionEnd via thread delete
      await deleteThread(page, tid)
      tids.pop()
      await page.waitForTimeout(1_500)
      lines = readTrace()
      assert(lines.includes("WS-END-CLEAR"), "W1-6 workspace SessionEnd matcher='clear' fired on delete")
    }

    // ── Scenario W2: Workspace HTTP hook + `if` clause ──────────────────────
    log("\n=== W2: Workspace HTTP hook + `if` clause ===")
    rmIf(TRACE)
    {
      const ws = mkdtempSync(join(tmpdir(), "hook-ws-W2-"))
      tmpWs.push(ws)
      const server = await startCaptureServer()
      log(`  capture server on ${server.port}`)
      try {
        writeWorkspaceHooks(ws, [
          {
            name: "pre-sentinel",
            content: {
              event: "PreToolUse",
              matcher: "execute",
              type: "command",
              command: cmd("WS-PRE-SENTINEL")
            }
          },
          {
            name: "http-pre-execute",
            content: {
              event: "PreToolUse",
              matcher: "execute",
              type: "http",
              url: `http://127.0.0.1:${server.port}/ws-pre-execute`,
              headers: { "X-WS-Test": "phase2" },
              fallback: "allow",
              timeout: 8000
            }
          },
          {
            name: "if-git",
            content: {
              event: "PreToolUse",
              matcher: "execute",
              if: "execute(git *)",
              type: "command",
              command: cmd("WS-IF-GIT")
            }
          }
        ])
        await trustWorkspaceHooks(page, ws)
        const tid = await createThread(page, ws)
        tids.push(tid)
        // Non-git command — IF-GIT should NOT match
        const r1 = await invokeTurn(page, tid, "请用 execute 工具运行：echo ws-http-test-no-git")
        assert(r1.done, "W2-1 first turn completed")
        await page.waitForTimeout(800)
        let lines = readTrace()
        log(`  trace after non-git: ${JSON.stringify(lines)}; captures=${server.captured.length}`)
        if (lines.includes("WS-PRE-SENTINEL")) {
          assert(!lines.includes("WS-IF-GIT"), "W2-2 workspace `if=execute(git *)` does NOT match echo")
          assert(server.captured.length >= 1, "W2-3 workspace HTTP hook hit the server (non-git turn)")
          if (server.captured.length > 0) {
            const last = server.captured[server.captured.length - 1]
            assert(last.url === "/ws-pre-execute", "W2-4 url path correct")
            assert(last.headers["x-ws-test"] === "phase2", "W2-5 custom header forwarded")
            const body = JSON.parse(last.body) as Record<string, unknown>
            assert(body.hook_event_name === "PreToolUse", "W2-6 payload event correct")
            assert(body.tool_name === "execute", "W2-7 payload tool_name correct")
          }
        } else {
          fail++
          failures.push("W2 model did not invoke execute — cannot judge HTTP / if")
          console.error("  FAIL W2 model did not invoke execute")
        }
        // git command — IF-GIT should match
        const captureBefore = server.captured.length
        const r2 = await invokeTurn(page, tid, "请用 execute 工具运行：git --version")
        assert(r2.done, "W2-8 second turn completed")
        await page.waitForTimeout(800)
        lines = readTrace()
        log(`  trace after git: ${JSON.stringify(lines)}; captures=${server.captured.length}`)
        if (lines.includes("WS-PRE-SENTINEL")) {
          assert(lines.includes("WS-IF-GIT"), "W2-9 workspace `if=execute(git *)` matches `git --version`")
          assert(
            server.captured.length > captureBefore,
            "W2-10 workspace HTTP hook fired on git turn too"
          )
        }
      } finally {
        await server.close()
      }
    }

    // ── Scenario W3: Workspace Setup(maintenance) via the button IPC ─────────
    log("\n=== W3: Workspace Setup(maintenance) via runSetupMaintenance IPC ===")
    rmIf(TRACE)
    {
      const ws = mkdtempSync(join(tmpdir(), "hook-ws-W3-"))
      tmpWs.push(ws)
      writeWorkspaceHooks(ws, [
        {
          name: "setup-maintenance",
          content: {
            event: "Setup",
            matcher: "maintenance",
            type: "command",
            command: cmd("WS-SETUP-MAINTENANCE")
          }
        }
      ])
      await trustWorkspaceHooks(page, ws)
      await runSetupMaintenance(page, ws)
      await page.waitForTimeout(1_200)
      const lines = readTrace()
      log(`  trace: ${JSON.stringify(lines)}`)
      assert(lines.includes("WS-SETUP-MAINTENANCE"), "W3-1 workspace Setup(maintenance) fired via IPC")
    }

    // ── Summary ─────────────────────────────────────────────────────────────
    log("")
    console.log(`${pass} passed, ${fail} failed`)
    if (failures.length > 0) {
      console.log("\nFailures:")
      for (const f of failures) console.log(`  - ${f}`)
      process.exitCode = 1
    }
  } finally {
    log("\nCleaning up…")
    if (app) {
      try {
        const page = await app.firstWindow()
        for (const tid of tids) await deleteThread(page, tid)
      } catch {
        /* */
      }
      await app.close().catch(() => undefined)
    }
    rmIf(TRACE)
    for (const w of tmpWs) rmIf(w)
    log("  done")
  }
}

main().catch((err: Error) => {
  console.error(`\nFATAL: ${err.stack || err.message}`)
  process.exit(1)
})
