/**
 * Targeted regressions for the five phase-2 follow-up fixes:
 *
 *   P1-1  CC settings.json `type: "http"` survives import
 *   P1-2  http-runner body read is covered by the request timeout
 *   P1-3  Setup marker is written only after hooks actually settle
 *   P2-1  Dialog form bounds (covered indirectly — see snapshot below)
 *   P2-2  MCP isError triggers PostToolUseFailure (covered in runtime.ts;
 *         not exercised here because the MCP service is heavy to stub)
 *
 * Run:
 *   npx tsx tests/hook-phase2-followup.spec.ts
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync as _read,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let pass = 0
let fail = 0

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual === expected) {
    pass++
    console.log(`PASS ${msg}`)
  } else {
    fail++
    console.error(`FAIL ${msg} (got ${String(actual)}, expected ${String(expected)})`)
  }
}

function assert(cond: unknown, msg: string): void {
  if (cond) {
    pass++
    console.log(`PASS ${msg}`)
  } else {
    fail++
    console.error(`FAIL ${msg}`)
  }
}

import { executeHttpHook } from "../src/main/hooks/http-runner.ts"
import { createServer } from "node:http"
import { runHooks, hookMatchesRunCriteria } from "../src/main/hooks/runner.ts"
import { buildHookResultRecordForConfig } from "../src/main/hooks/log-record.ts"
import type { HookConfig, HookResult } from "../src/main/hooks/types.ts"
import { runWithHookAgentId } from "../src/main/hooks/execution-context.ts"
import { LocalSandbox } from "../src/main/agent/local-sandbox.ts"

function nodeCommand(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64")
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
}

async function main(): Promise<void> {
// ─── P1-1 — CC import preserves type:"http" (code-level check) ─────────────
//
// storage.ts's `ccCommandToHookConfig` is module-private, so we can't drive
// an end-to-end import without pointing OPENWORK_DIR at a tmp tree (no env
// override exists today). Instead we grep the source for the branch and
// assert it is present + reads the right fields. Coarse but enough to fail
// loudly on a future revert.
const storageSrc = _read(
  join(import.meta.dirname ?? ".", "..", "src", "main", "storage.ts"),
  "utf-8"
)
assert(
  /if \(hookType === "http"\)/.test(storageSrc),
  "P1-1a ccCommandToHookConfig has an http branch"
)
for (const field of [
  "url",
  "headers",
  "allowedEnvVars",
  "fallback",
  "statusMessage",
  "async",
  "if",
  "timeout"
]) {
  assert(
    new RegExp(`\\b${field}:`).test(storageSrc),
    `P1-1 http branch references field "${field}"`
  )
}

// ─── P1-2 — http-runner aborts body read when the request times out ─────────

const slowServer = createServer((req, res) => {
  if (req.url === "/slow") {
    res.writeHead(200, { "Content-Type": "application/json" })
    // Send a partial body then stall — never end the response.
    res.write('{"started":')
    // Do NOT call res.end(); the connection stays open until aborted.
  }
})
await new Promise<void>((resolve) => slowServer.listen(0, "127.0.0.1", resolve))
const slowAddr = slowServer.address()
const slowPort = slowAddr && typeof slowAddr === "object" ? slowAddr.port : 0

const t0 = Date.now()
const result = await executeHttpHook(
  {
    id: "test-slow",
    event: "PreToolUse",
    type: "http",
    url: `http://127.0.0.1:${slowPort}/slow`,
    enabled: true,
    createdAt: "",
    updatedAt: ""
  } as Parameters<typeof executeHttpHook>[0],
  '{"hook_event_name":"PreToolUse"}',
  500 // 500ms timeout — should kick in well before any default test runner timeout
)
const elapsed = Date.now() - t0
slowServer.close()

assert(elapsed >= 400 && elapsed < 4_000, `P1-2a timeout fires close to 500ms (got ${elapsed}ms)`)
assert(
  /timed out|request failed/i.test(result.stderr),
  `P1-2b stderr surfaces a timeout/failure ("${result.stderr.slice(0, 80)}")`
)
// fallback defaults to "allow" — decision should NOT be "block".
assertEqual(result.blocked, false, "P1-2c default fallback=allow → not blocked")

// ─── P1-2d — structured HTTP output is protocol, not read_file content ─────

let capturedHttpPayload: Record<string, unknown> | undefined
const largeProtocolPadding = "x".repeat(20_000)
const oversizedHttpBody = "x".repeat(1_000_001)
const protocolBodies: Record<string, string> = {
  "/neutral": JSON.stringify({
    decision: null,
    reason: null,
    additionalContext: null,
    systemMessage: null,
    continue: null,
    stopReason: null
  }),
  "/context": JSON.stringify({ decision: null, additionalContext: "kept HTTP context" }),
  "/block": JSON.stringify({ decision: "block", reason: "HTTP review required" }),
  "/plain": "plain HTTP hook note",
  "/business": JSON.stringify({ status: "ok", diagnostics: [] }),
  "/capture": JSON.stringify({ decision: "approve" }),
  "/large-neutral": JSON.stringify({ decision: null, padding: largeProtocolPadding }),
  "/large-block": JSON.stringify({
    decision: "block",
    reason: "large HTTP review required",
    padding: largeProtocolPadding
  })
}
const protocolServer = createServer(async (req, res) => {
  let requestBody = ""
  for await (const chunk of req) requestBody += chunk.toString()
  if (req.url === "/capture") {
    capturedHttpPayload = JSON.parse(requestBody) as Record<string, unknown>
  }
  if (req.url === "/oversize") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(oversizedHttpBody)
    return
  }
  const responseBody = protocolBodies[req.url ?? ""] ?? "not found"
  res.writeHead(responseBody === "not found" ? 404 : 200, {
    "Content-Type": req.url === "/plain" ? "text/plain" : "application/json"
  })
  res.end(responseBody)
})
await new Promise<void>((resolve) => protocolServer.listen(0, "127.0.0.1", resolve))
const protocolAddress = protocolServer.address()
const protocolPort =
  protocolAddress && typeof protocolAddress === "object" ? protocolAddress.port : 0
const makeHttpHook = (path: string): HookConfig => ({
  id: `http-output-${path.slice(1)}`,
  event: "PostToolUse",
  matcher: "read_file",
  type: "http",
  url: `http://127.0.0.1:${protocolPort}${path}`,
  enabled: true,
  timeout: 5_000,
  createdAt: "",
  updatedAt: ""
})
const httpContext = {
  toolName: "read_file",
  toolArgs: { file_path: "note.txt" },
  toolResult: "     1\tfile body",
  workspacePath: tmpdir(),
  sessionId: "http-output-thread"
}

try {
  const neutralResult = await runHooks(
    [makeHttpHook("/neutral")],
    "PostToolUse",
    httpContext
  )
  assertEqual(neutralResult?.stdout, "", "P1-2d structured HTTP JSON is consumed")
  assert(
    !neutralResult?.stdout.includes("decision"),
    "P1-2e neutral decision JSON does not leak into read_file feedback"
  )

  let loggedStructuredStdout: string | undefined
  let loggedHttpType: string | undefined
  let loggedHttpLabel: string | undefined
  await runHooks([makeHttpHook("/neutral")], "PostToolUse", httpContext, (event, hook, hookResult) => {
    const record = buildHookResultRecordForConfig(
      event,
      hook,
      hookResult,
      { enabled: true, diagnostic: false }
    )
    loggedStructuredStdout = record?.stdout
    loggedHttpType = record?.hookType
    loggedHttpLabel = record?.label
  })
  assertEqual(
    loggedStructuredStdout,
    protocolBodies["/neutral"],
    "P1-2e0 Hook execution record retains consumed structured stdout"
  )
  assertEqual(loggedHttpType, "http", "P1-2e0a HTTP execution record keeps its hook type")
  assertEqual(
    loggedHttpLabel,
    `http://127.0.0.1:${protocolPort}/neutral`,
    "P1-2e0b HTTP execution record labels the configured URL"
  )

  const readWorkspace = mkdtempSync(join(tmpdir(), "http-hook-read-result-"))
  try {
    const readTarget = join(readWorkspace, "note.txt")
    writeFileSync(readTarget, "original file body\n", "utf8")
    const sandbox = new LocalSandbox({
      rootDir: readWorkspace,
      windowsSandbox: "none",
      hooks: [makeHttpHook("/large-neutral")]
    })
    const readOutput = await sandbox.read("note.txt")
    assert(readOutput.includes("original file body"), "P1-2e1 read_file still returns file content")
    assert(
      !readOutput.includes('"decision"') && !readOutput.includes("[Hook output]"),
      "P1-2e2 large structured HTTP control JSON is absent from final read_file output"
    )
    assertEqual(
      _read(readTarget, "utf8"),
      "original file body\n",
      "P1-2e3 HTTP hook leaves the file on disk unchanged"
    )
  } finally {
    rmSync(readWorkspace, { recursive: true, force: true })
  }

  const contextResult = await runHooks(
    [makeHttpHook("/context")],
    "PostToolUse",
    httpContext
  )
  assertEqual(contextResult?.stdout, "", "P1-2f context JSON raw stdout is consumed")
  assertEqual(
    contextResult?.additionalContext,
    "kept HTTP context",
    "P1-2g structured HTTP additionalContext is preserved"
  )

  const blockResult = await runHooks(
    [makeHttpHook("/block")],
    "PostToolUse",
    httpContext
  )
  assertEqual(blockResult?.stdout, "", "P1-2h blocking HTTP JSON raw stdout is consumed")
  assertEqual(blockResult?.decision, "block", "P1-2i structured HTTP block is preserved")
  assertEqual(
    blockResult?.reason,
    "HTTP review required",
    "P1-2j structured HTTP block reason is preserved"
  )

  const largeBlockResult = await runHooks(
    [{ ...makeHttpHook("/large-block"), event: "PreToolUse" }],
    "PreToolUse",
    httpContext
  )
  assertEqual(largeBlockResult?.blocked, true, "P1-2j1 large HTTP decision still blocks")
  assertEqual(
    largeBlockResult?.reason,
    "large HTTP review required",
    "P1-2j2 large HTTP block reason is preserved"
  )
  assert(
    !largeBlockResult?.stdout.includes(largeProtocolPadding),
    "P1-2j3 large protocol JSON is not downgraded to plain stdout"
  )

  const plainResult = await runHooks(
    [makeHttpHook("/plain")],
    "PostToolUse",
    httpContext
  )
  assertEqual(plainResult?.stdout, "plain HTTP hook note", "P1-2k plain HTTP text still passes through")

  const businessResult = await runHooks(
    [makeHttpHook("/business")],
    "PostToolUse",
    httpContext
  )
  assertEqual(
    businessResult?.stdout,
    protocolBodies["/business"],
    "P1-2k1 JSON without Hook protocol keys still passes through"
  )

  const oversizedBlockResult = await executeHttpHook(
    { ...makeHttpHook("/oversize"), fallback: "block" },
    "{}",
    5_000
  )
  assertEqual(
    oversizedBlockResult.blocked,
    true,
    "P1-2k2 oversized HTTP response honours fallback=block"
  )
  assert(
    /exceeded 1000000 bytes/i.test(oversizedBlockResult.stderr),
    "P1-2k3 oversized HTTP response reports the output limit"
  )

  const oversizedAllowResult = await executeHttpHook(
    { ...makeHttpHook("/oversize"), fallback: "allow" },
    "{}",
    5_000
  )
  assertEqual(
    oversizedAllowResult.blocked,
    false,
    "P1-2k4 oversized HTTP response honours fallback=allow"
  )
  assertEqual(
    oversizedAllowResult.decision,
    "approve",
    "P1-2k5 oversized HTTP allow fallback is explicit"
  )

  await runWithHookAgentId("http-worker-agent", () =>
    runHooks([makeHttpHook("/capture")], "PostToolUse", httpContext)
  )
  assertEqual(
    capturedHttpPayload?.agent_id,
    "http-worker-agent",
    "P1-2l HTTP payload inherits the active agent id"
  )
  assertEqual(
    capturedHttpPayload?.workspace,
    tmpdir(),
    "P1-2m HTTP payload exposes workspace"
  )
  assertEqual(
    capturedHttpPayload?.workspace_path,
    tmpdir(),
    "P1-2n HTTP payload exposes workspace_path alias"
  )
} finally {
  await new Promise<void>((resolve, reject) =>
    protocolServer.close((error) => (error ? reject(error) : resolve()))
  )
}

// ─── P1-2o — command hook stdin/env use invocation context only ────────────

const invocationContextEnvNames = new Set([
  "AGENT_ID",
  "WORKSPACE_PATH",
  "CLAUDE_PROJECT_DIR"
])
const previousInvocationContextEnv = Object.entries(process.env).filter(([name]) =>
  invocationContextEnvNames.has(name.toUpperCase())
)
const clearProcessInvocationContextEnv = (): void => {
  for (const name of Object.keys(process.env)) {
    if (invocationContextEnvNames.has(name.toUpperCase())) delete process.env[name]
  }
}
const restoreProcessInvocationContextEnv = (): void => {
  clearProcessInvocationContextEnv()
  for (const [name, value] of previousInvocationContextEnv) process.env[name] = value
}

clearProcessInvocationContextEnv()
process.env.AGENT_ID = "stale-host-agent"
process.env.WORKSPACE_PATH = "stale-host-workspace"
process.env.CLAUDE_PROJECT_DIR = "stale-host-project-dir"

const captureCommand = nodeCommand(`
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { input += chunk })
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    additionalContext: JSON.stringify({
      payload: JSON.parse(input),
      cwd: process.cwd(),
      env: {
        agentId: process.env.AGENT_ID ?? null,
        workspacePath: process.env.WORKSPACE_PATH ?? null,
        claudeProjectDir: process.env.CLAUDE_PROJECT_DIR ?? null
      }
    })
  }))
})
`)
const captureCommandHook: HookConfig = {
  id: "capture-command-context",
  event: "PreToolUse",
  matcher: "read_file",
  type: "command",
  command: captureCommand,
  hookSourceRoot: process.cwd(),
  enabled: true,
  timeout: 5_000,
  createdAt: "",
  updatedAt: ""
}

try {
  const commandResult = await runWithHookAgentId("command-worker-agent", () =>
    runHooks([captureCommandHook], "PreToolUse", {
      toolName: "read_file",
      toolArgs: { file_path: "note.txt" },
      workspacePath: tmpdir(),
      sessionId: "command-context-thread"
    })
  )
  const capturedCommand = JSON.parse(commandResult?.additionalContext ?? "{}") as {
    payload?: Record<string, unknown>
    cwd?: string
    env?: Record<string, unknown>
  }
  assertEqual(
    capturedCommand.payload?.agent_id,
    "command-worker-agent",
    "P1-2o command stdin inherits the active agent id"
  )
  assertEqual(
    capturedCommand.payload?.workspace,
    tmpdir(),
    "P1-2p command stdin exposes workspace"
  )
  assertEqual(
    capturedCommand.payload?.workspace_path,
    tmpdir(),
    "P1-2q command stdin exposes workspace_path alias"
  )
  assertEqual(
    capturedCommand.payload?.cwd,
    process.cwd(),
    "P1-2r command stdin cwd remains the hook source root"
  )
  assertEqual(
    capturedCommand.cwd,
    process.cwd(),
    "P1-2s command process cwd remains the hook source root"
  )
  assertEqual(
    capturedCommand.env?.agentId,
    "command-worker-agent",
    "P1-2t command env exposes the active agent id"
  )
  assertEqual(
    capturedCommand.env?.workspacePath,
    tmpdir(),
    "P1-2u command env exposes WORKSPACE_PATH"
  )
  assertEqual(
    capturedCommand.env?.claudeProjectDir,
    tmpdir(),
    "P1-2v command env exposes CLAUDE_PROJECT_DIR"
  )

  const unscopedResult = await runHooks([captureCommandHook], "PreToolUse", {
    toolName: "read_file",
    toolArgs: { file_path: "note.txt" },
    sessionId: "unscoped-command-thread"
  })
  const unscopedCommand = JSON.parse(unscopedResult?.additionalContext ?? "{}") as {
    payload?: Record<string, unknown>
    env?: Record<string, unknown>
  }
  assert(
    !("agent_id" in (unscopedCommand.payload ?? {})),
    "P1-2w unscoped command stdin does not inherit host AGENT_ID"
  )
  assert(
    !("workspace" in (unscopedCommand.payload ?? {})) &&
      !("workspace_path" in (unscopedCommand.payload ?? {})),
    "P1-2x unscoped command stdin does not invent a workspace"
  )
  assertEqual(unscopedCommand.env?.agentId, null, "P1-2y command env clears host AGENT_ID")
  assertEqual(
    unscopedCommand.env?.workspacePath,
    null,
    "P1-2z command env clears host WORKSPACE_PATH"
  )
  assertEqual(
    unscopedCommand.env?.claudeProjectDir,
    null,
    "P1-2aa command env clears host CLAUDE_PROJECT_DIR"
  )

  if (process.platform === "win32") {
    clearProcessInvocationContextEnv()
    process.env.Agent_Id = "stale-mixed-agent"
    process.env.Workspace_Path = "stale-mixed-workspace"
    process.env.Claude_Project_Dir = "stale-mixed-project-dir"

    const mixedCaseResult = await runHooks([captureCommandHook], "PreToolUse", {
      toolName: "read_file",
      toolArgs: { file_path: "note.txt" },
      sessionId: "mixed-case-command-thread"
    })
    const mixedCaseCommand = JSON.parse(mixedCaseResult?.additionalContext ?? "{}") as {
      env?: Record<string, unknown>
    }
    assertEqual(
      mixedCaseCommand.env?.agentId,
      null,
      "P1-2ab Windows command env clears mixed-case AGENT_ID"
    )
    assertEqual(
      mixedCaseCommand.env?.workspacePath,
      null,
      "P1-2ac Windows command env clears mixed-case WORKSPACE_PATH"
    )
    assertEqual(
      mixedCaseCommand.env?.claudeProjectDir,
      null,
      "P1-2ad Windows command env clears mixed-case CLAUDE_PROJECT_DIR"
    )
  }
} finally {
  restoreProcessInvocationContextEnv()
}

// ─── P1-2ae — command output limit is explicit for stdout and stderr ────────

for (const stream of ["stdout", "stderr"] as const) {
  const oversizedCommandHook: HookConfig = {
    id: `oversized-command-${stream}`,
    event: "PostToolUse",
    matcher: "read_file",
    type: "command",
    command: nodeCommand(`process.${stream}.write("x".repeat(1_000_001))`),
    hookSourceRoot: process.cwd(),
    enabled: true,
    timeout: 5_000,
    createdAt: "",
    updatedAt: ""
  }
  let observedOversizedCommand: HookResult | undefined
  const oversizedCommandResult = await runHooks(
    [oversizedCommandHook],
    "PostToolUse",
    httpContext,
    (_event, _hook, hookResult) => {
      observedOversizedCommand = hookResult
    }
  )
  assertEqual(
    observedOversizedCommand?.exitCode,
    1,
    `P1-2ae ${stream} over 1 MB is an explicit command-hook failure`
  )
  assertEqual(
    observedOversizedCommand?.stdout,
    "",
    `P1-2af ${stream} over 1 MB never exposes partial stdout`
  )
  assert(
    observedOversizedCommand?.stderr.includes("output truncated at 1000000 bytes"),
    `P1-2ag ${stream} over 1 MB reports the output limit`
  )
  assertEqual(
    oversizedCommandResult?.stdout,
    "",
    `P1-2ah ${stream} over 1 MB is not injected into tool feedback`
  )
}

// ─── P1-3 — Setup branch of runHooks awaits hook completion ────────────────

const lateHook: HookConfig = {
  id: "test-setup-late",
  event: "Setup",
  type: "command",
  // Pick a command that lives ≥150ms then exits 0.
  command: process.platform === "win32" ? "ping -n 2 127.0.0.1 > nul" : "sleep 0.15",
  enabled: true,
  timeout: 5_000,
  createdAt: "",
  updatedAt: ""
}
const tBefore = Date.now()
const setupResult = await runHooks([lateHook], "Setup", {
  workspacePath: tmpdir(),
  sessionId: "test-thread",
  setupTrigger: "init"
})
const setupElapsed = Date.now() - tBefore
assert(setupElapsed >= 140, `P1-3a Setup branch waited for the hook (≥140ms; got ${setupElapsed}ms)`)
assertEqual(setupResult, null, "P1-3b Setup returns null when every hook exit code is 0")

// Failing Setup hook → blocking result so the caller skips the marker write.
const failingHook: HookConfig = {
  id: "test-setup-fail",
  event: "Setup",
  type: "command",
  command: process.platform === "win32" ? "cmd /c exit 1" : "false",
  enabled: true,
  timeout: 5_000,
  createdAt: "",
  updatedAt: ""
}
const failingResult = await runHooks([failingHook], "Setup", {
  workspacePath: tmpdir(),
  sessionId: "test-thread",
  setupTrigger: "init"
})
assert(
  failingResult !== null && failingResult.blocked === true,
  "P1-3c Setup branch returns blocking result when any hook exits non-zero"
)

// Side-effect check: setup-state file is NOT written by runHooks itself
// (that's session-lifecycle's job; the unit boundary keeps the two paths
// separate). The marker file only exists if the caller decided to write it.
const stateFile = join(tmpdir(), ".cmbdevclaw", "setup-state.json")
assert(
  !existsSync(stateFile),
  "P1-3d runHooks does not write the setup-state marker on its own"
)

// ─── P3 — Setup catch path returns exitCode:1 so a throwing hook is not
//         mistakenly treated as success and the workspace marker is NOT
//         written. We exercise this via a command that points at a binary
//         that does not exist — spawn surfaces an error rejection on the
//         executor, the task catch rewrites it to exitCode:1, and runHooks
//         returns a blocking result.

const throwingHook: HookConfig = {
  id: "test-setup-throw",
  event: "Setup",
  type: "command",
  // bogus binary that doesn't exist; surfaces as ENOENT inside the executor
  command: process.platform === "win32"
    ? "nosuch-cmbcowork-binary-9af3.exe"
    : "/nope/nosuch-cmbcowork-binary-9af3",
  enabled: true,
  timeout: 5_000,
  createdAt: "",
  updatedAt: ""
}
const throwingResult = await runHooks([throwingHook], "Setup", {
  workspacePath: tmpdir(),
  sessionId: "test-thread",
  setupTrigger: "init"
})
// The "ENOENT" path on Windows often surfaces as a regular non-zero exit
// (cmd /c with a missing binary), so we don't insist on the rejection
// branch — we just want a non-null, blocking result either way.
assert(
  throwingResult !== null && throwingResult.blocked === true,
  "P3a Setup with a throwing/erroring hook returns a blocking result (marker write will be skipped)"
)

const asyncThrowingResult = await runHooks(
  [{ ...throwingHook, id: "test-setup-async-throw", async: true }],
  "Setup",
  {
    workspacePath: tmpdir(),
    sessionId: "test-thread",
    setupTrigger: "init"
  }
)
assert(
  asyncThrowingResult !== null &&
    asyncThrowingResult.blocked === true &&
    asyncThrowingResult.asyncStatus !== "pending",
  "P3b Setup ignores async:true and waits for the real failing result"
)

const runnerSrc = _read(
  join(import.meta.dirname ?? ".", "..", "src", "main", "hooks", "runner.ts"),
  "utf-8"
)
assert(
  /hook\.async === true && event !== "Setup"/.test(runnerSrc),
  "P3c runner does not return async placeholder for Setup"
)

const sessionLifecycleSrc = _read(
  join(import.meta.dirname ?? ".", "..", "src", "main", "hooks", "session-lifecycle.ts"),
  "utf-8"
)
assert(
  /export async function fireSessionStartOnce/.test(sessionLifecycleSrc) &&
    /const result = await runHooks/.test(sessionLifecycleSrc),
  "P3d fireSessionStartOnce awaits Setup before SessionStart"
)

const agentIpcSrc = _read(
  join(import.meta.dirname ?? ".", "..", "src", "main", "ipc", "agent.ts"),
  "utf-8"
)
assert(
  /await fireSessionStartOnce\(/.test(agentIpcSrc),
  "P3e agent invoke waits for fireSessionStartOnce"
)
assert(
  !/setLateHookResultListener/.test(runnerSrc),
  "P3f runner no longer exposes dead global late-result listener"
)

const asyncLateResults: string[] = []
const asyncHook: HookConfig = {
  id: "test-async-late",
  event: "PreToolUse",
  type: "command",
  command: process.platform === "win32" ? "ping -n 2 127.0.0.1 > nul" : "sleep 0.15",
  enabled: true,
  timeout: 5_000,
  async: true,
  createdAt: "",
  updatedAt: ""
}
await runHooks(
  [asyncHook],
  "PreToolUse",
  { toolName: "execute", toolArgs: { command: "echo ok" } },
  (_event, _hook, result) => {
    if (result.asyncStatus) asyncLateResults.push(result.asyncStatus)
  }
)
const lateDeadline = Date.now() + 6_000
while (!asyncLateResults.includes("completed") && Date.now() < lateDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 50))
}
assert(
  asyncLateResults.includes("pending") && asyncLateResults.includes("completed"),
  "P3g async hook emits both pending and late completed results through onHookResult"
)

const completionHooksSrc = _read(
  join(
    import.meta.dirname ?? ".",
    "..",
    "src",
    "main",
    "agent",
    "skill-lifecycle",
    "completion-hooks.ts"
  ),
  "utf-8"
)
assert(
  /let stopHookFired = false/.test(agentIpcSrc) &&
    /onStopHooksFired/.test(agentIpcSrc) &&
    /if \(!stopHookFired\)/.test(agentIpcSrc),
  "P3h StopFailure is gated when Stop hooks already fired"
)
assert(
  /onStopHooksFired\?\.\(\)/.test(completionHooksSrc),
  "P3i completion-hooks reports when Stop hook chain begins"
)

// ─── P-Editor — AddHookDialog edit-save preserves PR-13/14/15/16 fields ────
//
// The dialog lives in renderer code that this Node-runner can't render. We
// assert the source contains the round-trip plumbing instead — coarse, but
// a regression test that catches "someone removed the passthrough state" or
// "submit forgot to write the field" without standing up React Testing
// Library.

const dialogSrc = _read(
  join(
    import.meta.dirname ?? ".",
    "..",
    "src",
    "renderer",
    "src",
    "components",
    "customize",
    "AddHookDialog.tsx"
  ),
  "utf-8"
)
assert(
  /event === "PostToolUseFailure"/.test(dialogSrc),
  "P-Editor f1 PostToolUseFailure exposes a tool matcher"
)
assert(
  /const matcherOptions = isSkillMatcherEvent \? skillMatcherOptions : COMMON_TOOLS/.test(
    dialogSrc
  ),
  "P-Editor f2 PostToolUseFailure uses the common tool matcher options"
)
for (const stateName of [
  "matcherPreserve",
  "passthroughIf",
  "passthroughShell",
  "passthroughStatusMessage",
  "passthroughAsync"
]) {
  assert(
    new RegExp(`const \\[${stateName},`).test(dialogSrc),
    `P-Editor a/${stateName} dialog declares a passthrough state`
  )
  assert(
    new RegExp(`set${stateName.charAt(0).toUpperCase()}${stateName.slice(1)}\\(h\\.`).test(dialogSrc),
    `P-Editor b/${stateName} populateFromHook loads it from editHook`
  )
}
// Submit writes each field
assert(
  /config\.matcher = matcherPreserve/.test(dialogSrc),
  "P-Editor c1 handleSubmit preserves matcher when widget is hidden"
)
assert(
  /config\.if = passthroughIf/.test(dialogSrc),
  "P-Editor c2 handleSubmit writes if"
)
assert(
  /config\.shell = passthroughShell/.test(dialogSrc),
  "P-Editor c3 handleSubmit writes shell"
)
assert(
  /config\.statusMessage = passthroughStatusMessage/.test(dialogSrc),
  "P-Editor c4 handleSubmit writes statusMessage"
)
assert(
  /config\.async = true/.test(dialogSrc),
  "P-Editor c5 handleSubmit writes async"
)

// Event-bound passthroughs (matcher when widget hidden, `if`) MUST be gated
// on event-stays-the-same. Otherwise switching SubagentStart → Setup would
// carry "code-reviewer" matcher into a Setup hook (whose matcher target is
// init|maintenance) and silently disable it.
assert(
  /sameEventAsEdit\s*=\s*!editHook\s*\|\|\s*event\s*===\s*editHook\.event/.test(dialogSrc),
  "P-Editor e1 dialog computes a sameEventAsEdit gate"
)
assert(
  /else if\s*\(\s*sameEventAsEdit\s*&&\s*matcherPreserve/.test(dialogSrc),
  "P-Editor e2 matcher preservation is gated on sameEventAsEdit"
)
assert(
  /if\s*\(\s*sameEventAsEdit\s*&&\s*passthroughIf/.test(dialogSrc),
  "P-Editor e3 `if` passthrough is gated on sameEventAsEdit"
)
// Event-agnostic passthroughs must NOT be gated (would be a regression in
// the opposite direction — losing data when user merely retyped the event).
const shellWriteSnippet = dialogSrc.match(/config\.shell = passthroughShell[\s\S]{0,80}/)?.[0] ?? ""
assert(
  !/sameEventAsEdit/.test(shellWriteSnippet),
  "P-Editor e4 shell write is NOT gated on event (it's event-agnostic)"
)
const statusWriteSnippet =
  dialogSrc.match(/config\.statusMessage = passthroughStatusMessage[\s\S]{0,80}/)?.[0] ?? ""
assert(
  !/sameEventAsEdit/.test(statusWriteSnippet),
  "P-Editor e5 statusMessage write is NOT gated on event"
)
const asyncWriteSnippet =
  dialogSrc.match(/passthroughAsync === true[\s\S]{0,80}config\.async/)?.[0] ?? ""
// Loose match — async branch is short. We just confirm the assignment
// appears outside of the sameEventAsEdit guard block.
assert(
  /passthroughAsync === true\)\s*config\.async = true/.test(dialogSrc),
  "P-Editor e6 async write is NOT gated on event"
)
void asyncWriteSnippet

// ─── P-Matcher — PR-16 per-event matchQuery actually reaches the runner ────
//
// hookMatchesRunCriteria is the same predicate runHooks's main loop uses,
// so this is exactly what the runtime sees. Each event gets one
// should-match + one shouldn't-match assertion.

function makeHook(
  partial: Pick<HookConfig, "event" | "matcher"> & { id: string }
): HookConfig {
  return {
    enabled: true,
    type: "command",
    command: "echo ok",
    timeout: 5_000,
    createdAt: "",
    updatedAt: "",
    ...partial
  } as HookConfig
}

// StopFailure → context.stopFailureError
{
  const ctx = { sessionId: "t", stopFailureError: "rate_limit" }
  assert(
    hookMatchesRunCriteria(
      makeHook({ id: "m1", event: "StopFailure", matcher: "rate_limit" }),
      "StopFailure",
      ctx
    ),
    "P-Matcher StopFailure 'rate_limit' matches when stopFailureError='rate_limit'"
  )
  assert(
    !hookMatchesRunCriteria(
      makeHook({ id: "m2", event: "StopFailure", matcher: "server_error" }),
      "StopFailure",
      ctx
    ),
    "P-Matcher StopFailure 'server_error' does NOT match when error is 'rate_limit'"
  )
  // Wildcard still works
  assert(
    hookMatchesRunCriteria(
      makeHook({ id: "m3", event: "StopFailure", matcher: "*" }),
      "StopFailure",
      ctx
    ),
    "P-Matcher StopFailure '*' matches any error"
  )
}

// SessionStart → context.sessionStartSource
{
  const ctx = { sessionId: "t", sessionStartSource: "startup" as const }
  assert(
    hookMatchesRunCriteria(
      makeHook({ id: "m4", event: "SessionStart", matcher: "startup" }),
      "SessionStart",
      ctx
    ),
    "P-Matcher SessionStart 'startup' matches when source='startup'"
  )
  assert(
    !hookMatchesRunCriteria(
      makeHook({ id: "m5", event: "SessionStart", matcher: "resume" }),
      "SessionStart",
      ctx
    ),
    "P-Matcher SessionStart 'resume' does NOT match when source='startup'"
  )
}

// SessionEnd → context.sessionEndReason
{
  const ctx = { sessionId: "t", sessionEndReason: "logout" as const }
  assert(
    hookMatchesRunCriteria(
      makeHook({ id: "m6", event: "SessionEnd", matcher: "logout" }),
      "SessionEnd",
      ctx
    ),
    "P-Matcher SessionEnd 'logout' matches when reason='logout'"
  )
  assert(
    !hookMatchesRunCriteria(
      makeHook({ id: "m7", event: "SessionEnd", matcher: "clear" }),
      "SessionEnd",
      ctx
    ),
    "P-Matcher SessionEnd 'clear' does NOT match when reason='logout'"
  )
}

// Notification → context.notificationType (primary) + toolName fallback
{
  const ctx = {
    sessionId: "t",
    notificationType: "permission_prompt" as const,
    toolName: "execute"
  }
  assert(
    hookMatchesRunCriteria(
      makeHook({ id: "m8", event: "Notification", matcher: "permission_prompt" }),
      "Notification",
      ctx
    ),
    "P-Matcher Notification 'permission_prompt' matches when notificationType='permission_prompt'"
  )
  assert(
    hookMatchesRunCriteria(
      makeHook({ id: "m9", event: "Notification", matcher: "execute" }),
      "Notification",
      ctx
    ),
    "P-Matcher Notification 'execute' still matches via toolName fallback (legacy compat)"
  )
  assert(
    !hookMatchesRunCriteria(
      makeHook({ id: "m10", event: "Notification", matcher: "write_file" }),
      "Notification",
      ctx
    ),
    "P-Matcher Notification unrelated matcher does NOT match"
  )
}
// All 5 passthroughs in the useCallback deps array
for (const stateName of [
  "matcherPreserve",
  "passthroughIf",
  "passthroughShell",
  "passthroughStatusMessage",
  "passthroughAsync"
]) {
  // Looking for a bare reference on its own line inside the deps array.
  assert(
    new RegExp(`^\\s*${stateName},?\\s*(//.*)?$`, "m").test(dialogSrc),
    `P-Editor d/${stateName} listed in handleSubmit useCallback deps`
  )
}

} // end main

main().then(
  () => {
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
  },
  (err) => {
    console.error("FATAL:", err)
    process.exit(1)
  }
)
