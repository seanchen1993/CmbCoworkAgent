import { AsyncLocalStorage } from "node:async_hooks"
import type { WebContents } from "electron"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

/** Native main-frame identity; never serialized, exported to a guest or inferred from a URL. */
export interface FunctionMarkdownDisplayScope {
  epoch: object
  assertCurrent(): void
}

const display = new AsyncLocalStorage<FunctionMarkdownDisplayScope>()
const frames = new WeakMap<WebContents, { epoch: object }>()

/** Navigation can reuse a WebFrameMain object, so object equality alone is insufficient. */
export function captureFunctionMarkdownFrame(contents: WebContents): FunctionMarkdownDisplayScope {
  let state = frames.get(contents)
  if (!state) {
    state = { epoch: {} }
    frames.set(contents, state)
    const current = state
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame) current.epoch = {}
    })
    contents.on("render-process-gone", () => {
      current.epoch = {}
    })
    contents.once("destroyed", () => {
      current.epoch = {}
    })
  }
  const epoch = state.epoch
  const frame = contents.mainFrame
  const current = state
  return {
    epoch,
    assertCurrent: () => {
      if (contents.isDestroyed() || current.epoch !== epoch || contents.mainFrame !== frame)
        throw new ModFunctionError("MODS_UI_MARKDOWN_STALE")
    }
  }
}

export function withFunctionMarkdownDisplay<T>(
  scope: FunctionMarkdownDisplayScope,
  run: () => T
): T {
  scope.assertCurrent()
  return display.run(scope, run)
}

export function captureFunctionMarkdownDisplay(): FunctionMarkdownDisplayScope | undefined {
  const scope = display.getStore()
  scope?.assertCurrent()
  return scope
}
