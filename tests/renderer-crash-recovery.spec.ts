/**
 * A blank window is the worst failure this app has, because it takes the UI
 * that would have explained it. Two things stand between a throw and that
 * window: a boundary around the whole tree, and one reload after the renderer
 * process dies. Neither can be exercised here — there is no jsdom in this suite
 * and no Electron — so these assert the wiring instead, which is the part that
 * silently disappears in a refactor.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8")
}

function testTheWholeTreeSitsInsideABoundary(): void {
  const entry = read("src/renderer/src/main.tsx")
  assert(
    entry.includes("AppErrorBoundary"),
    "the renderer entry must mount a top-level error boundary"
  )
  const opening = entry.indexOf("<AppErrorBoundary>")
  const closing = entry.indexOf("</AppErrorBoundary>")
  const app = entry.indexOf("<App />")
  assert(opening >= 0 && closing > opening, "the boundary must wrap, not merely be imported")
  assert(
    app > opening && app < closing,
    "App must render inside the boundary; outside it a throw is still a blank window"
  )

  const boundary = read("src/renderer/src/components/app/AppErrorBoundary.tsx")
  assert(
    boundary.includes("getDerivedStateFromError"),
    "the boundary must render a fallback rather than rethrow"
  )
  assert(
    boundary.includes("componentStack"),
    "the component stack is the part console output does not carry; keep reporting it"
  )
  assert(
    boundary.includes("console.error"),
    "the failure must reach renderer.log through console, with no IPC channel of its own"
  )
  assert(
    !/componentDidCatch[\s\S]{0,400}location\.reload/.test(boundary),
    "reloading automatically on a render error loops forever when the error recurs"
  )
  console.log("PASS testTheWholeTreeSitsInsideABoundary")
}

function testADeadRendererIsReloadedExactlyOnce(): void {
  const main = read("src/main/index.ts")
  const handler = main.slice(
    main.indexOf('mainWindow.webContents.on("render-process-gone"'),
    main.indexOf('mainWindow.webContents.on("did-finish-load"')
  )
  assert(handler.length > 0, "the render-process-gone handler must exist")
  assert(
    handler.includes("reload()"),
    "a dead renderer leaves a blank window; nothing inside it can recover on its own"
  )
  assert(
    handler.includes("rendererRecovered"),
    "recovery must be guarded, or a fault that recurs on load reloads forever"
  )
  assert(
    handler.includes("details.reason"),
    'the reason must be recorded: "oom" and "crashed" look identical on screen'
  )
  console.log("PASS testADeadRendererIsReloadedExactlyOnce")
}

testTheWholeTreeSitsInsideABoundary()
testADeadRendererIsReloadedExactlyOnce()
console.log("renderer crash recovery tests passed")
