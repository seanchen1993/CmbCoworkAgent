/**
 * Contract for the managed transport AgentRunDelivery.
 *
 * src/main/agent/managed-transport-delivery.ts hands agent.ts an object that satisfies
 * only part of BrowserWindow, cast through `as unknown as BrowserWindow`. That
 * cast silences the compiler, so a new `window.<member>` in agent.ts compiles
 * fine and then throws at runtime — on the IM path only, possibly in a rarely
 * taken branch, long after the change that caused it.
 *
 * This suite is what actually holds that line. It tests source shape because
 * the constraint IS a source-level one: no behavioural test can reach every
 * branch that might touch a fifth member.
 *
 * Run:
 *   npx tsx tests/agent-window-surface.spec.ts
 */

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const PROJECT_ROOT = resolve(__dirname, "..")

function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n")
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Every BrowserWindow member managed-transport-delivery.ts's window shim provides. */
const SUPPORTED_WINDOW_MEMBERS = new Set([
  "id",
  "isDestroyed",
  "webContents.send",
  "webContents.isDestroyed"
])

function testAgentWindowSurfaceStaysShimSafe(): void {
  const agent = read("src/main/ipc/agent.ts")

  // `window` is the only BrowserWindow-typed identifier the run body threads
  // through; `win` appears solely inside BrowserWindow.getAllWindows() loops,
  // which iterate real windows and never see the shim.
  const used = new Set<string>()
  for (const match of agent.matchAll(/\bwindow\.([A-Za-z]+(?:\.[A-Za-z]+)?)/g)) {
    const member = match[1]
    if (member === undefined) continue
    // `window.webContents` alone (no member access) is a narrowing/guard read,
    // which the shim's plain object satisfies.
    if (member === "webContents") continue
    used.add(member)
  }

  const unsupported = [...used].filter((member) => !SUPPORTED_WINDOW_MEMBERS.has(member))
  assert(
    unsupported.length === 0,
    `agent.ts uses BrowserWindow members the managed transport delivery cannot provide: ` +
      `${unsupported.join(", ")}\n` +
      `  → either add them to managedWindow in src/main/agent/managed-transport-delivery.ts,\n` +
      `    or route the call through delivery.send() / AgentRunExecutionContext instead.`
  )
  assert(used.size > 0, "window member scan matched nothing — the regex or agent.ts moved")
}

function testManagedDeliveryDeclaresExactlyThatSurface(): void {
  const managed = read("src/main/agent/managed-transport-delivery.ts")
  for (const member of ["id:", "isDestroyed:", "send:", "webContents:"]) {
    assert(
      managed.includes(member),
      `managed transport delivery must define ${member} to satisfy agent.ts's window usage`
    )
  }
  assert(
    managed.includes("isAvailable: () => true"),
    "a managed run must never be gated on a desktop window being available"
  )
}

function testOnlyDesktopRunsCanOpenAModal(): void {
  const agent = read("src/main/ipc/agent.ts")
  // dialog.showMessageBox needs a real BrowserWindow to parent to. Every path
  // reaching it must be gated, or a managed run crashes inside auto-commit.
  const dialogCalls = [...agent.matchAll(/dialog\.[A-Za-z]+\(/g)].map((match) => match[0])
  assert(
    dialogCalls.length === 1 && dialogCalls[0] === "dialog.showMessageBox(",
    `agent.ts gained a new Electron dialog call (${dialogCalls.join(", ")}); ` +
      `each one needs a real window and must be gated like confirmAutoCommit`
  )
  assert(
    agent.includes("canPromptModal ? { confirm:"),
    "the auto-commit confirmation modal must stay behind the canPromptModal gate"
  )
  // "Desktop-owned" is not the same as "has a window": the main-process summary
  // scheduler is desktop-owned and carries the shim, so the source test alone
  // parented a modal to something that is not a BrowserWindow.
  assert(
    /canPromptModal:\s*\n?\s*runExecutionContext\.source === "desktop" && !isManagedTransportWindow\(window\)/.test(
      agent
    ),
    "the run body must only allow a modal for a desktop-owned run that has a real window"
  )
}

function testManagedTransportsNeverFallBackToNoDelivery(): void {
  const main = read("src/main/index.ts")
  // Returning null here is what made an IM Goal turn fail outright whenever the
  // desktop happened to be closed ("主窗口尚未就绪" out of requireDelivery).
  assert(
    main.includes("createManagedTransportAgentRunDelivery()"),
    "the IM delivery resolver must fall back to a managed transport delivery, not null"
  )
  assert(
    !/setAgentRunDeliveryResolver\(\(\) =>[\s\S]{0,200}?:\s*null\s*\)/.test(main),
    "the IM delivery resolver must not resolve to null when no window is open"
  )
}

const tests = [
  testAgentWindowSurfaceStaysShimSafe,
  testManagedDeliveryDeclaresExactlyThatSurface,
  testOnlyDesktopRunsCanOpenAModal,
  testManagedTransportsNeverFallBackToNoDelivery
]

let failed = 0
for (const test of tests) {
  try {
    test()
    console.log(`PASS ${test.name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${test.name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (failed > 0) {
  console.error(`agent-window-surface.spec.ts: ${failed} failed`)
  process.exit(1)
}
console.log("agent-window-surface.spec.ts passed")
