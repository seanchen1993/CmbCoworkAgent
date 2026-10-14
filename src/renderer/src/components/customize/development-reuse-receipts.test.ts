import { expect, it, vi } from "vitest"
import type { ReuseSelection } from "./development-reuse-receipts"
import { readReuseSelection, rememberReuseSelection, subscribeReuseSelection } from "./development-reuse-receipts"

it("delivers chat reuse selection to the already mounted same-scope workbench without permissions", () => {
  const scope = JSON.stringify(["thread", "C:/Project"])
  const listener = vi.fn()
  const other = vi.fn()
  const unsubscribe = subscribeReuseSelection(scope, listener)
  const unsubscribeOther = subscribeReuseSelection("other", other)
  const selection = {
    document: { workspace: "C:/Project", id: "draft", source: { digest: "digest", files: [] } },
    origin: { id: "draft", revision: 1, digest: "digest" }
  } as unknown as ReuseSelection
  rememberReuseSelection(scope, selection)
  expect(listener).toHaveBeenCalledOnce()
  expect(other).not.toHaveBeenCalled()
  const copy = readReuseSelection(scope)!
  copy.origin.id = "mutated"
  expect(readReuseSelection(scope)?.origin.id).toBe("draft")
  expect(readReuseSelection(scope)).not.toHaveProperty("prepared")
  rememberReuseSelection(scope, null)
  expect(listener).toHaveBeenCalledTimes(2)
  expect(readReuseSelection(scope)).toBeNull()
  unsubscribe()
  unsubscribeOther()
  rememberReuseSelection(scope, selection)
  expect(listener).toHaveBeenCalledTimes(2)
  rememberReuseSelection(scope, null)
})
