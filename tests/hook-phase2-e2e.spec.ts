/**
 * Phase-2 hook E2E — drives the real built Electron app to validate two
 * behaviours that source assertions / unit tests can't fully prove:
 *
 *   Scenario A — Stop fires, StopFailure does NOT (happy-path mutex).
 *                A turn that completes normally must fire Stop hooks once and
 *                must NOT fire StopFailure. This exercises the new
 *                `stopHookFired` flag wired through `onStopHooksFired` in
 *                runCompletionHooksWithRevision + the catch-block gate in
 *                ipc/agent.ts:2616.
 *
 *   Scenario B — Setup(maintenance) HTTP hook end-to-end.
 *                Calls the `hooks:setup:maintenance` IPC and confirms a
 *                configured `type:"http"` hook actually POSTs to a local
 *                server with a CC-shape payload. Exercises validateHookConfig
 *                http branch + http-runner + the maintenance IPC handler.
 *
 * Run:
 *   npx tsx tests/hook-phase2-e2e.spec.ts
 *
 * Prereqs:
 *   - `npm run build` (out/main/index.js exists)
 *   - The user's default model is reachable from this machine. We don't add
 *     a temp model — Scenario A leans on whatever the user has configured.
 *
 * Hooks created are tagged with `e2e-phase2-` prefixes; the spec deletes them
 * via the public `hooks:delete` IPC at the end so the user's hooks.json is
 * restored to its prior state on a clean exit.
 */

import { _electron as electron, type ElectronApplication, type Page } from "playwright"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const PROJECT_ROOT = resolve(__dirname, "..")
const ELECTRON_LAUNCHER =
  process.platform === "win32"
    ? join(PROJECT_ROOT, "tests", "support", "electron-launcher.cmd")
    : join(PROJECT_ROOT, "node_modules", ".bin", "electron")
const MAIN_ENTRY = join(PROJECT_ROOT, "out", "main", "index.js")
const TURN_TIMEOUT_MS = 3 * 60 * 1000

// Side-effect log files for command hooks — picked in tmpdir so the hooks
// themselves resolve them via env (no Windows / POSIX quoting hell).
const STOP_LOG = join(tmpdir(), `e2e-phase2-stop-${process.pid}.log`)
const STOPFAIL_LOG = join(tmpdir(), `e2e-phase2-stopfail-${process.pid}.log`)
// Scenario 0 — shared file so Setup vs SessionStart ordering is observable
// from line order alone. Setup is awaited; SessionStart fires after.
const ORDER_LOG = join(tmpdir(), `e2e-phase2-order-${process.pid}.log`)

interface HookHandle {
  id: string
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`)
}

let pass = 0
let fail = 0
function assert(cond: unknown, msg: string): void {
  if (cond) {
    pass++
    console.log(`  PASS ${msg}`)
  } else {
    fail++
    console.error(`  FAIL ${msg}`)
  }
}

function rmIfExists(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// ── Scenario B's local HTTP capture server ─────────────────────────────────

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

async function startCaptureServer(): Promise<{
  port: number
  captured: CapturedRequest[]
  close: () => Promise<void>
}> {
  const captured: CapturedRequest[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      captured.push({
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf-8")
      })
      res.writeHead(200, { "Content-Type": "application/json" })
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

// ── Page-level helpers — all run via page.evaluate so they hit real IPC ────

async function createHook(page: Page, config: Record<string, unknown>): Promise<HookHandle> {
  return await page.evaluate(async (cfg) => {
    const api = (window as unknown as { api: { hooks: { create: (c: unknown) => Promise<{ id: string }> } } })
      .api
    return await api.hooks.create(cfg)
  }, config)
}

async function deleteHook(page: Page, id: string): Promise<void> {
  await page.evaluate(async (hookId) => {
    const api = (window as unknown as { api: { hooks: { delete: (id: string) => Promise<void> } } }).api
    await api.hooks.delete(hookId)
  }, id)
}

async function runSetupMaintenance(page: Page, workspacePath: string): Promise<void> {
  await page.evaluate(async (wsp) => {
    const api = (window as unknown as {
      api: { hooks: { workspace: { runSetupMaintenance: (p: string) => Promise<void> } } }
    }).api
    await api.hooks.workspace.runSetupMaintenance(wsp)
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
    if (!id) throw new Error(`threads.create returned no id: ${JSON.stringify(t)}`)
    await api.workspace.set(id, wsp)
    return id
  }, workspacePath)
}

async function runOneTurn(
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
              cb: (evt: { type: string; error?: string }) => void,
              modelId?: string
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

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`No built output at ${MAIN_ENTRY} — run \`npm run build\` first`)
  }

  rmIfExists(STOP_LOG)
  rmIfExists(STOPFAIL_LOG)
  rmIfExists(ORDER_LOG)

  log("Launching Electron…")
  let app: ElectronApplication | undefined
  let scenarioBServer: Awaited<ReturnType<typeof startCaptureServer>> | undefined
  const createdHookIds: string[] = []
  const tempWorkspaces: string[] = []

  try {
    // ELECTRON_RUN_AS_NODE leaks in from the VSCode / Claude Code host env
    // and forces electron.exe to behave as plain node, breaking require("electron").
    // Strip it before launch — Playwright's child inherits this env.
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
    log("Window ready")

    // Helper script shared across scenarios — cross-platform "append a line
    // to a file" via a tiny node helper, avoiding Windows / POSIX shell-
    // quoting differences. A stray re-fire shows up as a second line.
    const helperScript = join(PROJECT_ROOT, "tests", "support", "append-line.cjs")

    // ── Scenario 0 ────────────────────────────────────────────────────────
    // Setup(init) fires on first-ever SessionStart for a fresh workspace,
    // AWAITED before SessionStart begins (per PR-11 follow-up fix). The
    // shared ORDER_LOG captures fire order as line order.
    log("\n=== Scenario 0: Setup(init) fires before SessionStart, marker written ===")

    const initWs = mkdtempSync(join(tmpdir(), "e2e-phase2-init-"))
    tempWorkspaces.push(initWs)
    log(`  Fresh workspace: ${initWs}`)

    const setupInitCmd = `node "${helperScript}" "${ORDER_LOG}" SETUP_INIT`
    const sessionStartCmd = `node "${helperScript}" "${ORDER_LOG}" SESSION_START`
    const setupInitHook = await createHook(page, {
      event: "Setup",
      type: "command",
      command: setupInitCmd,
      matcher: "init",
      timeout: 8_000,
      enabled: true
    })
    createdHookIds.push(setupInitHook.id)
    const sessionStartHook = await createHook(page, {
      event: "SessionStart",
      type: "command",
      command: sessionStartCmd,
      matcher: "*",
      timeout: 8_000,
      enabled: true
    })
    createdHookIds.push(sessionStartHook.id)
    log(`  Setup(init) hook id=${setupInitHook.id}`)
    log(`  SessionStart hook id=${sessionStartHook.id}`)

    const initThreadId = await createThread(page, initWs)
    log(`  Thread id=${initThreadId} (workspace=${initWs})`)
    log("  Invoking turn #1 to trigger fireSessionStartOnce…")
    const initTurn = await runOneTurn(page, initThreadId, "请只回复一个词：done")
    log(`  Turn finished: done=${initTurn.done} error=${initTurn.error ?? "-"}`)
    assert(initTurn.done, "0-1 first turn completed")

    // SessionStart is fire-and-forget; give it a moment to flush.
    await page.waitForTimeout(1_500)

    const orderContent = existsSync(ORDER_LOG) ? readFileSync(ORDER_LOG, "utf-8").trim() : ""
    const orderLines = orderContent.split(/\r?\n/).filter(Boolean)
    log(`  ORDER_LOG lines: ${JSON.stringify(orderLines)}`)
    const setupIdx = orderLines.indexOf("SETUP_INIT")
    const startIdx = orderLines.indexOf("SESSION_START")
    assert(setupIdx >= 0, "0-2 Setup(init) hook fired")
    assert(startIdx >= 0, "0-3 SessionStart hook fired")
    assert(
      setupIdx >= 0 && startIdx >= 0 && setupIdx < startIdx,
      `0-4 Setup(init) fired BEFORE SessionStart (got setup=${setupIdx}, start=${startIdx})`
    )

    const markerPath = join(initWs, ".cmbdevclaw", "setup-state.json")
    assert(existsSync(markerPath), "0-5 setup-state.json marker written after successful Setup")
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, "utf-8"))
      assert(typeof marker.initialisedAt === "string", "0-6 marker carries initialisedAt timestamp")
    }

    // Cleanup Scenario 0 hooks before Scenario A so PROJECT_ROOT's
    // (already-initialised) SessionStart doesn't re-fire and pollute counters.
    await deleteHook(page, setupInitHook.id)
    await deleteHook(page, sessionStartHook.id)
    createdHookIds.splice(createdHookIds.indexOf(setupInitHook.id), 1)
    createdHookIds.splice(createdHookIds.indexOf(sessionStartHook.id), 1)

    // ── Scenario A ────────────────────────────────────────────────────────
    log("\n=== Scenario A: Stop fires, StopFailure does NOT (happy path) ===")

    const stopCmd = `node "${helperScript}" "${STOP_LOG}" STOP_FIRED`
    const stopFailCmd = `node "${helperScript}" "${STOPFAIL_LOG}" STOPFAILURE_FIRED`

    const stopHook = await createHook(page, {
      event: "Stop",
      type: "command",
      command: stopCmd,
      matcher: "*",
      timeout: 8_000,
      enabled: true
    })
    createdHookIds.push(stopHook.id)
    log(`  Stop hook id=${stopHook.id}`)

    const stopFailHook = await createHook(page, {
      event: "StopFailure",
      type: "command",
      command: stopFailCmd,
      matcher: "*",
      timeout: 8_000,
      enabled: true
    })
    createdHookIds.push(stopFailHook.id)
    log(`  StopFailure hook id=${stopFailHook.id}`)

    // Use the project root as the workspace; the temp marker for Setup
    // won't be triggered because we don't configure a Setup hook here.
    const threadId = await createThread(page, PROJECT_ROOT)
    log(`  Thread id=${threadId}`)

    log("  Invoking turn (real LLM, expect ~few seconds)…")
    const turnResult = await runOneTurn(page, threadId, "请只回复一个词：done")
    log(`  Turn finished: done=${turnResult.done} error=${turnResult.error ?? "-"}`)
    assert(turnResult.done, "A1 turn completed without an error")

    // Allow fire-and-forget Stop hook side-effect to flush.
    await page.waitForTimeout(1_500)

    const stopLogContent = existsSync(STOP_LOG) ? readFileSync(STOP_LOG, "utf-8") : ""
    const stopFailLogContent = existsSync(STOPFAIL_LOG) ? readFileSync(STOPFAIL_LOG, "utf-8") : ""
    log(`  STOP_LOG content: ${JSON.stringify(stopLogContent)}`)
    log(`  STOPFAIL_LOG content: ${JSON.stringify(stopFailLogContent)}`)

    assert(stopLogContent.includes("STOP_FIRED"), "A2 Stop hook fired on happy-path turn")
    assert(
      !stopFailLogContent.includes("STOPFAILURE_FIRED"),
      "A3 StopFailure hook did NOT fire on happy-path turn"
    )
    // Stop hook should fire EXACTLY once for a one-shot turn. If you see ≥2,
    // the revision loop got triggered (PostSkillUse / Stop block decision)
    // or a duplicate event source crept in.
    const stopFireCount = (stopLogContent.match(/STOP_FIRED/g) || []).length
    assert(stopFireCount === 1, `A4 Stop hook fired exactly once (got ${stopFireCount})`)

    // Cleanup Scenario A hooks before B so they don't interfere with future
    // Setup-only events (Stop hook would fire if maintenance somehow chained).
    await deleteHook(page, stopHook.id)
    await deleteHook(page, stopFailHook.id)
    createdHookIds.splice(createdHookIds.indexOf(stopHook.id), 1)
    createdHookIds.splice(createdHookIds.indexOf(stopFailHook.id), 1)

    // ── Scenario B ────────────────────────────────────────────────────────
    log("\n=== Scenario B: Setup(maintenance) HTTP hook end-to-end ===")

    scenarioBServer = await startCaptureServer()
    log(`  Capture server listening on http://127.0.0.1:${scenarioBServer.port}/`)

    const tempWs = mkdtempSync(join(tmpdir(), "e2e-phase2-ws-"))
    tempWorkspaces.push(tempWs)
    log(`  Temp workspace: ${tempWs}`)

    const httpHook = await createHook(page, {
      event: "Setup",
      type: "http",
      url: `http://127.0.0.1:${scenarioBServer.port}/setup-maintenance`,
      // matcher target for Setup is the trigger ("init" | "maintenance")
      matcher: "maintenance",
      headers: { "X-E2E": "phase2" },
      timeout: 8_000,
      enabled: true
    })
    createdHookIds.push(httpHook.id)
    log(`  HTTP Setup hook id=${httpHook.id}`)

    log("  Triggering hooks:setup:maintenance…")
    await runSetupMaintenance(page, tempWs)

    // Maintenance is fire-and-forget at the IPC layer but the runner awaits
    // hook completion (Setup branch). Still give the network round-trip a
    // small slack.
    await page.waitForTimeout(800)

    log(`  Captured requests: ${scenarioBServer.captured.length}`)
    assert(scenarioBServer.captured.length === 1, "B1 capture server received exactly one POST")
    if (scenarioBServer.captured.length > 0) {
      const req = scenarioBServer.captured[0]
      log(`  Request: ${req.method} ${req.url}`)
      log(`  X-E2E header: ${req.headers["x-e2e"] ?? "<missing>"}`)
      log(`  Body (first 200): ${req.body.slice(0, 200)}`)
      assert(req.method === "POST", "B2 method is POST")
      assert(req.url === "/setup-maintenance", "B3 url path is /setup-maintenance")
      assert(req.headers["x-e2e"] === "phase2", "B4 custom header X-E2E forwarded")

      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(req.body) as Record<string, unknown>
      } catch {
        /* */
      }
      assert(parsed.hook_event_name === "Setup", "B5 payload.hook_event_name === 'Setup'")
      assert(parsed.trigger === "maintenance", "B6 payload.trigger === 'maintenance'")
      assert(parsed.workspace_path === tempWs, "B7 payload.workspace_path matches temp workspace")
    }

    // ── Scenario C ────────────────────────────────────────────────────────
    // Verify the "重新初始化工作区" button exists in WorkspacePicker and is
    // wired to runSetupMaintenance. The IPC end-to-end is already proven by
    // Scenario B; the renderer-side regression we care about is the glue:
    // does the React component actually declare a button whose handler calls
    // the right preload API? Source-level assert beats DOM driving here —
    // the popover only renders for the currently-active thread/workspace,
    // and faking that from outside requires significant test-only renderer
    // surgery for marginal gain over the typecheck + source assertion.
    log("\n=== Scenario C: WorkspacePicker exposes 重新初始化工作区 ===")

    const wpSrc = readFileSync(
      join(PROJECT_ROOT, "src", "renderer", "src", "components", "chat", "WorkspacePicker.tsx"),
      "utf-8"
    )
    assert(/重新初始化工作区/.test(wpSrc), "C1 WorkspacePicker declares the 重新初始化工作区 button")
    assert(
      /window\.api\.hooks\.workspace\.runSetupMaintenance\(workspacePath\)/.test(wpSrc),
      "C2 button handler calls runSetupMaintenance with the current workspace"
    )
    assert(
      /onClick=\{handleReinitWorkspace\}/.test(wpSrc),
      "C3 button is wired to handleReinitWorkspace (no orphan handler)"
    )

    // ── Result ────────────────────────────────────────────────────────────
    log("")
    console.log(`${pass} passed, ${fail} failed`)
    if (fail > 0) {
      process.exitCode = 1
    }
  } finally {
    log("\nCleaning up…")
    if (app && createdHookIds.length > 0) {
      try {
        const page = await app.firstWindow()
        for (const id of createdHookIds) {
          await deleteHook(page, id).catch(() => undefined)
        }
        log(`  Removed ${createdHookIds.length} leftover hook(s)`)
      } catch (err) {
        console.warn("  Hook cleanup via IPC failed:", err)
      }
    }
    if (scenarioBServer) await scenarioBServer.close().catch(() => undefined)
    if (app) await app.close().catch(() => undefined)
    rmIfExists(STOP_LOG)
    rmIfExists(STOPFAIL_LOG)
    rmIfExists(ORDER_LOG)
    for (const ws of tempWorkspaces) rmIfExists(ws)
    log("  Done")
  }
}

main().catch((err: Error) => {
  console.error(`\nFATAL: ${err.stack || err.message}`)
  process.exit(1)
})
