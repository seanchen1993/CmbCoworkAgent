/**
 * Comprehensive E2E driving every auto-testable scenario in docs/hook-test-cases.md.
 *
 * v2 — trace-based gating instead of relying on stream events. The
 * `tool_call` StreamEvent type is declared in src/main/types.ts but never
 * emitted by the agent IPC, so we can't peek at tool invocations from the
 * renderer side. The hooks themselves are the ground truth: if a sentinel
 * PreToolUse hook fires, the model actually invoked the tool.
 *
 * Skipped scenarios (require user state mutation we don't want to do):
 *   - StopFailure: needs apiKey corruption
 *   - Notification: needs non-yolo sandbox mode
 *   - PreSkillUse / PostSkillUse: depends on user-installed skills
 *
 * Run:  unset ELECTRON_RUN_AS_NODE && npx tsx tests/hook-test-cases-e2e.spec.ts
 */

import { _electron as electron, type ElectronApplication, type Page } from "playwright"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
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

const TRACE = join(tmpdir(), `hook-cases-trace-${process.pid}.log`)

let pass = 0
let fail = 0
const failures: string[] = []
const skipped: string[] = []

function ts(): string {
  return new Date().toISOString().slice(11, 23)
}
function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`)
}
function assert(cond: unknown, msg: string): void {
  if (cond) {
    pass++
    console.log(`  PASS ${msg}`)
  } else {
    fail++
    failures.push(msg)
    console.error(`  FAIL ${msg}`)
  }
}
function skip(msg: string): void {
  skipped.push(msg)
  console.log(`  SKIP ${msg}`)
}
function rmIf(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
function readTrace(): string[] {
  if (!existsSync(TRACE)) return []
  return readFileSync(TRACE, "utf-8").split(/\r?\n/).filter(Boolean)
}
function clearTrace(): void {
  rmIf(TRACE)
}

// ── Page helpers ────────────────────────────────────────────────────────────

interface HookHandle {
  id: string
}

async function createHook(page: Page, config: Record<string, unknown>): Promise<HookHandle> {
  return await page.evaluate(async (cfg) => {
    return await (window as unknown as {
      api: { hooks: { create: (c: unknown) => Promise<{ id: string }> } }
    }).api.hooks.create(cfg)
  }, config)
}

async function deleteHooks(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await page.evaluate(async (hookId) => {
        await (window as unknown as {
          api: { hooks: { delete: (id: string) => Promise<void> } }
        }).api.hooks.delete(hookId)
      }, id)
    } catch {
      /* ignore */
    }
  }
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

async function deleteThread(page: Page, threadId: string): Promise<void> {
  try {
    await page.evaluate(async (id) => {
      await (window as unknown as {
        api: { threads: { delete: (id: string) => Promise<void> } }
      }).api.threads.delete(id)
    }, threadId)
  } catch {
    /* ignore */
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
  captured: { url: string; method: string; headers: Record<string, string | string[] | undefined>; body: string }[]
  close: () => Promise<void>
}> {
  const captured: {
    url: string
    method: string
    headers: Record<string, string | string[] | undefined>
    body: string
  }[] = []
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

function cmd(tag: string): string {
  return `node "${HELPER}" "${TRACE}" "${tag}"`
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`No built output at ${MAIN_ENTRY} — run \`npm run build\` first`)
  }

  log("Launching Electron…")
  let app: ElectronApplication | undefined
  const tmpWorkspaces: string[] = []
  const createdThreadIds: string[] = []
  const allCreatedHooks: string[] = []

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

    const withHooks = async <T>(
      configs: Record<string, unknown>[],
      run: (ids: string[]) => Promise<T>
    ): Promise<T> => {
      const ids: string[] = []
      for (const c of configs) {
        const h = await createHook(page, c)
        ids.push(h.id)
        allCreatedHooks.push(h.id)
      }
      try {
        return await run(ids)
      } finally {
        await deleteHooks(page, ids)
        for (const id of ids) {
          const i = allCreatedHooks.indexOf(id)
          if (i >= 0) allCreatedHooks.splice(i, 1)
        }
      }
    }

    // ── Scenario 1: UserPromptSubmit + SessionStart + Stop ──────────────────
    log("=== Scenario 1: UserPromptSubmit + SessionStart + Stop (one turn) ===")
    clearTrace()
    {
      const ws = mkdtempSync(join(tmpdir(), "hook-cases-ws1-"))
      tmpWorkspaces.push(ws)
      await withHooks(
        [
          { event: "UserPromptSubmit", matcher: "*", type: "command", command: cmd("USER-PROMPT"), enabled: true },
          { event: "SessionStart", matcher: "*", type: "command", command: cmd("SESSION-START"), enabled: true },
          { event: "Stop", matcher: "*", type: "command", command: cmd("STOP"), enabled: true }
        ],
        async () => {
          const tid = await createThread(page, ws)
          createdThreadIds.push(tid)
          const r = await invokeTurn(page, tid, "请只回复：done")
          assert(r.done, "S1 turn completed")
          await page.waitForTimeout(1_200)
          const lines = readTrace()
          log(`  trace: ${JSON.stringify(lines)}`)
          assert(lines.includes("USER-PROMPT"), "S1 UserPromptSubmit fired")
          assert(lines.includes("SESSION-START"), "S1 SessionStart fired (first turn)")
          assert(lines.includes("STOP"), "S1 Stop fired")
        }
      )
    }

    // ── Scenario 2: PreToolUse + PostToolUse on execute ─────────────────────
    log("\n=== Scenario 2: PreToolUse + PostToolUse (execute tool) ===")
    clearTrace()
    await withHooks(
      [
        { event: "PreToolUse", matcher: "execute", type: "command", command: cmd("PRE-EXECUTE"), enabled: true },
        { event: "PostToolUse", matcher: "execute", type: "command", command: cmd("POST-EXECUTE"), enabled: true }
      ],
      async () => {
        const tid = createdThreadIds[0]
        const r = await invokeTurn(page, tid, "请用 execute 工具运行：echo hello-from-pre-post-test")
        assert(r.done, "S2 turn completed")
        await page.waitForTimeout(1_200)
        const lines = readTrace()
        log(`  trace: ${JSON.stringify(lines)}`)
        const fired = lines.includes("PRE-EXECUTE") || lines.includes("POST-EXECUTE")
        if (!fired) {
          fail++
          failures.push("S2 model never invoked execute (no PRE/POST in trace)")
          console.error("  FAIL S2 model did not invoke execute")
        } else {
          assert(lines.includes("PRE-EXECUTE"), "S2 PreToolUse fired on execute")
          assert(lines.includes("POST-EXECUTE"), "S2 PostToolUse fired on execute")
          const preIdx = lines.indexOf("PRE-EXECUTE")
          const postIdx = lines.indexOf("POST-EXECUTE")
          assert(preIdx < postIdx, "S2 PRE fires before POST")
        }
      }
    )

    // ── Scenario 3: PostToolUseFailure on a non-zero exit ───────────────────
    // Use a sentinel PRE hook to confirm the model actually invoked execute;
    // otherwise a missing TOOL-FAILURE could mean "model didn't try" not
    // "failure detection broken". Use a deterministically-failing built-in:
    // `cmd /c exit 5` on Windows, `false` elsewhere.
    log("\n=== Scenario 3: PostToolUseFailure (non-zero exit) ===")
    clearTrace()
    {
      const failingCmd =
        process.platform === "win32" ? "cmd /c exit 5" : "false"
      await withHooks(
        [
          { event: "PreToolUse", matcher: "execute", type: "command", command: cmd("PRE-SENTINEL"), enabled: true },
          {
            event: "PostToolUseFailure",
            matcher: "*",
            type: "command",
            command: cmd("TOOL-FAILURE"),
            enabled: true
          }
        ],
        async () => {
          const tid = createdThreadIds[0]
          const r = await invokeTurn(
            page,
            tid,
            `请用 execute 工具运行：${failingCmd}。这个命令会非零退出，你不需要修复，只需要回报一下退出码即可。`
          )
          log(`  done=${r.done} error=${r.error ?? "-"}`)
          await page.waitForTimeout(1_500)
          const lines = readTrace()
          log(`  trace: ${JSON.stringify(lines)}`)
          if (!lines.includes("PRE-SENTINEL")) {
            skip("S3 model did not invoke execute — cannot judge PostToolUseFailure")
          } else {
            // Fixed: detectToolFailure now pattern-matches the deepagents
            // execute tool's "[Command failed with exit code N]" tail line
            // even when the result is a plain string (was returning null on
            // any non-object before, plus local-sandbox.ts gave up on
            // non-JSON strings before reaching the detector at all).
            assert(
              lines.includes("TOOL-FAILURE"),
              `S3 PostToolUseFailure fires on execute non-zero exit (trace=${JSON.stringify(lines)})`
            )
          }
        }
      )
    }

    // ── Scenario 4: Setup init + maintenance ────────────────────────────────
    log("\n=== Scenario 4: Setup(init) + Setup(maintenance) ===")
    clearTrace()
    {
      const ws = mkdtempSync(join(tmpdir(), "hook-cases-ws4-"))
      tmpWorkspaces.push(ws)
      await withHooks(
        [
          { event: "Setup", matcher: "init", type: "command", command: cmd("SETUP-INIT"), enabled: true },
          {
            event: "Setup",
            matcher: "maintenance",
            type: "command",
            command: cmd("SETUP-MAINTENANCE"),
            enabled: true
          }
        ],
        async () => {
          const tid = await createThread(page, ws)
          createdThreadIds.push(tid)
          const r = await invokeTurn(page, tid, "请只回复：ok")
          assert(r.done, "S4-1 init turn completed")
          await page.waitForTimeout(1_500)
          let lines = readTrace()
          log(`  trace after init: ${JSON.stringify(lines)}`)
          assert(lines.includes("SETUP-INIT"), "S4-2 Setup(init) fired on fresh workspace")
          assert(!lines.includes("SETUP-MAINTENANCE"), "S4-3 Setup(maintenance) did NOT fire from init path")
          const marker = join(ws, ".cmbcoworkagent", "setup-state.json")
          assert(existsSync(marker), "S4-4 setup-state.json marker written")
          const initMtime = existsSync(marker) ? statSync(marker).mtimeMs : 0

          await runSetupMaintenance(page, ws)
          await page.waitForTimeout(1_500)
          lines = readTrace()
          log(`  trace after maintenance: ${JSON.stringify(lines)}`)
          assert(lines.includes("SETUP-MAINTENANCE"), "S4-5 Setup(maintenance) fired via IPC")
          const initCount = lines.filter((l) => l === "SETUP-INIT").length
          assert(initCount === 1, `S4-6 Setup(init) NOT re-fired by maintenance (count=${initCount})`)
          const newMtime = existsSync(marker) ? statSync(marker).mtimeMs : 0
          assert(newMtime === initMtime, "S4-7 marker mtime unchanged after maintenance")
        }
      )
    }

    // ── Scenario 5: SubagentStart + SubagentStop ────────────────────────────
    log("\n=== Scenario 5: SubagentStart + SubagentStop (task tool) ===")
    clearTrace()
    await withHooks(
      [
        { event: "SubagentStart", matcher: "*", type: "command", command: cmd("SUB-START"), enabled: true },
        { event: "SubagentStop", matcher: "*", type: "command", command: cmd("SUB-STOP"), enabled: true }
      ],
      async () => {
        const tid = createdThreadIds[0]
        const r = await invokeTurn(
          page,
          tid,
          "请用 task 工具派一个子代理调研 c:\\\\ai\\\\CmbCoworkAgent 根目录下有哪些子目录，让它只用 ls 工具，完成后用 1 句话回报。"
        )
        log(`  done=${r.done}`)
        await page.waitForTimeout(2_000)
        const lines = readTrace()
        log(`  trace: ${JSON.stringify(lines)}`)
        if (!lines.includes("SUB-START") && !lines.includes("SUB-STOP")) {
          skip("S5 model did not invoke task tool — SubagentStart/Stop not exercised this run")
        } else {
          assert(lines.includes("SUB-START"), "S5 SubagentStart fired on task tool")
          assert(lines.includes("SUB-STOP"), "S5 SubagentStop fired on task tool")
          const startIdx = lines.indexOf("SUB-START")
          const stopIdx = lines.indexOf("SUB-STOP")
          assert(startIdx < stopIdx, "S5 SubagentStart fires before SubagentStop")
        }
      }
    )

    // ── Scenario 6: HTTP hook ───────────────────────────────────────────────
    log("\n=== Scenario 6: HTTP hook (real fetch to local server) ===")
    clearTrace()
    {
      const server = await startCaptureServer()
      log(`  capture server on 127.0.0.1:${server.port}`)
      try {
        await withHooks(
          [
            { event: "PreToolUse", matcher: "execute", type: "command", command: cmd("PRE-SENTINEL"), enabled: true },
            {
              event: "PreToolUse",
              matcher: "execute",
              type: "http",
              url: `http://127.0.0.1:${server.port}/pre-execute`,
              headers: { "X-E2E": "cases" },
              timeout: 8_000,
              enabled: true
            }
          ],
          async () => {
            const tid = createdThreadIds[0]
            const r = await invokeTurn(page, tid, "请用 execute 工具运行：echo http-hook-test")
            log(`  done=${r.done}`)
            await page.waitForTimeout(800)
            const lines = readTrace()
            const capCount = server.captured.length
            log(`  PRE-SENTINEL in trace: ${lines.includes("PRE-SENTINEL")}; captured=${capCount}`)
            if (!lines.includes("PRE-SENTINEL")) {
              skip("S6 model did not invoke execute — HTTP hook not exercised")
            } else {
              assert(capCount >= 1, `S6 HTTP hook reached the server (>=1 POST, got ${capCount})`)
              if (capCount > 0) {
                const last = server.captured[capCount - 1]
                assert(last.method === "POST", "S6 method=POST")
                assert(last.url === "/pre-execute", "S6 url path is /pre-execute")
                assert(last.headers["x-e2e"] === "cases", "S6 custom header X-E2E forwarded")
                try {
                  const body = JSON.parse(last.body) as Record<string, unknown>
                  assert(body.hook_event_name === "PreToolUse", "S6 payload.hook_event_name=PreToolUse")
                  assert(body.tool_name === "execute", "S6 payload.tool_name=execute")
                } catch {
                  fail++
                  failures.push("S6 payload was not valid JSON")
                  console.error("  FAIL S6 payload was not valid JSON")
                }
              }
            }
          }
        )
      } finally {
        await server.close()
      }
    }

    // ── Scenario 7: async hook ──────────────────────────────────────────────
    log("\n=== Scenario 7: async hook (placeholder + late side-effect) ===")
    clearTrace()
    {
      const sleepHelper = join(PROJECT_ROOT, "tests", "support", "sleep-then-append.cjs")
      const sleepCmd = `node "${sleepHelper}" "${TRACE}" "ASYNC-LATE" 1200`
      await withHooks(
        [
          { event: "PreToolUse", matcher: "execute", type: "command", command: cmd("PRE-SENTINEL"), enabled: true },
          {
            event: "PreToolUse",
            matcher: "execute",
            type: "command",
            command: sleepCmd,
            async: true,
            timeout: 8_000,
            enabled: true
          }
        ],
        async () => {
          const tid = createdThreadIds[0]
          const r = await invokeTurn(page, tid, "请用 execute 工具运行：echo async-test")
          assert(r.done, "S7-1 turn completed")
          await page.waitForTimeout(2_500)
          const lines = readTrace()
          log(`  trace: ${JSON.stringify(lines)}`)
          if (!lines.includes("PRE-SENTINEL")) {
            skip("S7 model did not invoke execute — async hook not exercised")
          } else {
            assert(lines.includes("ASYNC-LATE"), "S7-2 async hook's late side-effect landed")
          }
        }
      )
    }

    // ── Scenario 8: SessionEnd matchQuery (clear) ────────────────────────────
    log("\n=== Scenario 8: SessionEnd matcher='clear' fires on thread:delete ===")
    clearTrace()
    await withHooks(
      [
        { event: "SessionEnd", matcher: "clear", type: "command", command: cmd("END-CLEAR"), enabled: true },
        { event: "SessionEnd", matcher: "logout", type: "command", command: cmd("END-LOGOUT"), enabled: true }
      ],
      async () => {
        const ws = mkdtempSync(join(tmpdir(), "hook-cases-ws8-"))
        tmpWorkspaces.push(ws)
        const tid = await createThread(page, ws)
        const r = await invokeTurn(page, tid, "请只回复：ok")
        assert(r.done, "S8-1 setup turn completed (SessionStart fired)")
        await page.waitForTimeout(800)
        await deleteThread(page, tid)
        await page.waitForTimeout(1_500)
        const lines = readTrace()
        log(`  trace: ${JSON.stringify(lines)}`)
        assert(lines.includes("END-CLEAR"), "S8-2 SessionEnd matcher='clear' fired on thread delete")
        assert(!lines.includes("END-LOGOUT"), "S8-3 SessionEnd matcher='logout' did NOT fire (no app quit)")
      }
    )

    // ── Scenario 9: if clause filtering ─────────────────────────────────────
    log("\n=== Scenario 9: `if` clause execute(git *) — only matches git commands ===")
    clearTrace()
    await withHooks(
      [
        { event: "PreToolUse", matcher: "execute", type: "command", command: cmd("PRE-SENTINEL"), enabled: true },
        {
          event: "PreToolUse",
          matcher: "execute",
          if: "execute(git *)",
          type: "command",
          command: cmd("IF-GIT"),
          enabled: true
        }
      ],
      async () => {
        const tid = createdThreadIds[0]
        // Turn A: non-git command
        clearTrace()
        const r1 = await invokeTurn(page, tid, "请用 execute 工具运行：echo no-git-here")
        await page.waitForTimeout(800)
        const linesA = readTrace()
        log(`  turn A trace: ${JSON.stringify(linesA)} done=${r1.done}`)
        if (!linesA.includes("PRE-SENTINEL")) {
          skip("S9-A model did not invoke execute on echo — cannot judge if clause")
        } else {
          assert(!linesA.includes("IF-GIT"), "S9-1 `if=execute(git *)` does NOT match `echo`")
        }
        // Turn B: git command
        clearTrace()
        const r2 = await invokeTurn(page, tid, "请用 execute 工具运行：git --version")
        await page.waitForTimeout(800)
        const linesB = readTrace()
        log(`  turn B trace: ${JSON.stringify(linesB)} done=${r2.done}`)
        if (!linesB.includes("PRE-SENTINEL")) {
          skip("S9-B model did not invoke execute on git — cannot judge if clause")
        } else {
          assert(linesB.includes("IF-GIT"), "S9-2 `if=execute(git *)` DOES match `git --version`")
        }
      }
    )

    // ── Summary ─────────────────────────────────────────────────────────────
    log("")
    console.log(`${pass} passed, ${fail} failed, ${skipped.length} skipped`)
    if (skipped.length > 0) {
      console.log("\nSkipped:")
      for (const s of skipped) console.log(`  - ${s}`)
    }
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
        if (allCreatedHooks.length > 0) {
          await deleteHooks(page, [...allCreatedHooks])
          log(`  removed ${allCreatedHooks.length} leftover hook(s)`)
        }
        for (const tid of createdThreadIds) {
          await deleteThread(page, tid)
        }
        if (createdThreadIds.length > 0) log(`  deleted ${createdThreadIds.length} thread(s)`)
      } catch (e) {
        console.warn("  cleanup via IPC failed:", e)
      }
      await app.close().catch(() => undefined)
    }
    rmIf(TRACE)
    for (const w of tmpWorkspaces) rmIf(w)
    log("  done")
  }
}

main().catch((err: Error) => {
  console.error(`\nFATAL: ${err.stack || err.message}`)
  process.exit(1)
})
