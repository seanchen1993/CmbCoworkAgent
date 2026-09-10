/**
 * A managed transport run has no BrowserWindow — it carries a shim with `id`,
 * `isDestroyed` and `webContents`, and a Proxy that throws on anything else so a
 * missing member says which call needs routing rather than failing as
 * "w.focus is not a function" somewhere downstream.
 *
 * The main-process summary scheduler broke the assumption that made that safe.
 * "Desktop-owned run" used to imply "has a real window", because only a
 * renderer's own invoke was desktop-owned. The scheduler is desktop-owned by
 * every other measure and has no window at all, so two gates written as
 * `source === "desktop"` reached straight into the shim: subscribing to the
 * window's "closed" event, and offering an auto-commit confirmation modal.
 *
 * The first one shipped, and it surfaced as 代理出错 on every Team summary:
 *   A managed transport run reached BrowserWindow.once, which its window shim
 *   does not implement (it has id, isDestroyed, webContents).
 *
 * Run:
 *   npx tsx tests/managed-run-window-shim.spec.ts
 */

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  MANAGED_TRANSPORT_WINDOW_ID,
  createManagedTransportAgentRunDelivery,
  isManagedTransportWindow
} from "../src/main/agent/managed-transport-delivery.ts"
import { subscribeWindowClosed } from "../src/main/services/window-close-subscriptions.ts"

const PROJECT_ROOT = resolve(__dirname, "..")

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n")
}

/** The shim really does refuse `once`, so the gates below are load-bearing. */
function testTheShimRefusesWindowOnlyMembers(): void {
  const delivery = createManagedTransportAgentRunDelivery({
    mirror: () => undefined,
    broadcast: () => undefined
  })
  assert(
    isManagedTransportWindow(delivery.window),
    "a managed run's window must identify itself as the shim"
  )
  assert(delivery.window.id === MANAGED_TRANSPORT_WINDOW_ID, "the shim keeps its synthetic id")

  let reached = false
  try {
    subscribeWindowClosed(delivery.window, () => undefined)
    reached = true
  } catch (error) {
    assert(
      String(error).includes("BrowserWindow.once"),
      `the shim must name the member that is missing, got: ${String(error)}`
    )
  }
  assert(
    !reached,
    "subscribing to the shim's close event must still throw — if the shim grows " +
      "`once`, the guards in agent.ts become silent no-ops and this test is the " +
      "only thing that would notice"
  )
}

/**
 * Source-checked, because reaching these lines needs a whole run. Both are the
 * same mistake — asking who owns the run when the question is whether there is
 * a window — so they are asserted together.
 */
function testWindowOnlyWorkIsGatedOnHavingAWindow(): void {
  const agent = read("src/main/ipc/agent.ts")

  const gates = [
    {
      what: "the window-close subscription",
      pattern:
        /runExecutionContext\.source === "desktop" && !isManagedTransportWindow\(window\)\s*\n?\s*\? subscribeWindowClosed\(window, onWindowClosed\)/
    },
    {
      what: "the auto-commit confirmation modal",
      pattern:
        /canPromptModal:\s*\n?\s*runExecutionContext\.source === "desktop" && !isManagedTransportWindow\(window\)/
    }
  ]
  for (const gate of gates) {
    assert(
      gate.pattern.test(agent),
      `${gate.what} must be gated on having a real window, not on who owns the run`
    )
  }

  // The other subscribeWindowClosed call sites take their window from
  // BrowserWindow.fromWebContents, so they always have a real one. Only the
  // shared run body can be entered by a managed transport, which is why it is
  // the one gated above. Deliberately not asserted by counting call sites: the
  // count is four higher than the reachable one, and a test that says otherwise
  // would be asserting something false.
}

function main(): void {
  testTheShimRefusesWindowOnlyMembers()
  console.log("PASS testTheShimRefusesWindowOnlyMembers")
  testWindowOnlyWorkIsGatedOnHavingAWindow()
  console.log("PASS testWindowOnlyWorkIsGatedOnHavingAWindow")
  console.log("managed-run-window-shim.spec.ts passed")
}

try {
  main()
} catch (error) {
  console.error(`FAIL ${(error as Error).message}`)
  process.exit(1)
}
