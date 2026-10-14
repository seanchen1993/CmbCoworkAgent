import { describe, expect, it } from "vitest"
import { ModelSelectionIntentRegistry } from "./model-selection-intent"

describe("model selection intent ownership", () => {
  it("keeps captures stable until an explicit advance, including repeated advances", () => {
    const registry = new ModelSelectionIntentRegistry()
    const first = registry.capture("a")
    const unchanged = registry.capture("a")
    expect(Object.isFrozen(first)).toBe(true)
    expect(unchanged.lifetime).toBe(first.lifetime)
    expect(unchanged.intent).toBe(first.intent)

    registry.advance("a")
    const second = registry.capture("a")
    registry.advance("a")
    const third = registry.capture("a")
    expect(registry.isCurrent(first)).toBe(false)
    expect(registry.isCurrent(second)).toBe(false)
    expect(registry.isCurrent(third)).toBe(true)
    expect(registry.isLifetimeCurrent(first)).toBe(true)
    expect(third.lifetime).toBe(first.lifetime)
    expect(registry.retainedThreadCount).toBe(1)
  })

  it("does not invalidate another thread's choice", () => {
    const registry = new ModelSelectionIntentRegistry()
    const first = registry.capture("a")
    const other = registry.capture("b")
    registry.advance("a")
    expect(registry.isCurrent(first)).toBe(false)
    expect(registry.isCurrent(other)).toBe(true)
    expect(registry.retainedThreadCount).toBe(2)
  })

  it("does not create a thread while checking or advancing released receipts", () => {
    const registry = new ModelSelectionIntentRegistry()
    const old = registry.capture("a")
    registry.release("a")
    registry.advance("a")
    expect(registry.isCurrent(old)).toBe(false)
    expect(registry.isLifetimeCurrent(old)).toBe(false)
    expect(registry.retainedThreadCount).toBe(0)
  })

  it("rejects a removed lifetime after reopening the same thread id", () => {
    const registry = new ModelSelectionIntentRegistry()
    const old = registry.capture("a")
    registry.release("a")
    const reopened = registry.capture("a")
    expect(reopened.lifetime).not.toBe(old.lifetime)
    expect(registry.isCurrent(old)).toBe(false)
    expect(registry.isLifetimeCurrent(old)).toBe(false)
    expect(registry.isCurrent(reopened)).toBe(true)
    expect(registry.retainedThreadCount).toBe(1)
  })

  it("fences unknown and confirmed pinned configuration changes", () => {
    const registry = new ModelSelectionIntentRegistry()
    const unknown = registry.capture("a")
    registry.onModsConfigurationChanged()
    expect(registry.confirmedRoutingMode).toBeNull()
    expect(registry.isCurrent(unknown)).toBe(false)

    registry.confirmRoutingModeRead(registry.beginRoutingModeRead(), "pinned")
    const pinned = registry.capture("a")
    registry.onModsConfigurationChanged()
    expect(registry.confirmedRoutingMode).toBe("pinned")
    expect(registry.isCurrent(pinned)).toBe(false)
    expect(registry.isLifetimeCurrent(pinned)).toBe(true)
  })

  it("preserves confirmed auto receipts through unrelated Mods configuration events", () => {
    const registry = new ModelSelectionIntentRegistry()
    registry.confirmRoutingModeRead(registry.beginRoutingModeRead(), "auto")
    const auto = registry.capture("a")
    registry.onModsConfigurationChanged()
    registry.onModsConfigurationChanged()
    expect(registry.confirmedRoutingMode).toBe("auto")
    expect(registry.isCurrent(auto)).toBe(true)
  })

  it("fences every retained thread before an unconfirmed mode change can finish", () => {
    const registry = new ModelSelectionIntentRegistry()
    registry.confirmRoutingModeRead(registry.beginRoutingModeRead(), "auto")
    const first = registry.capture("a")
    const other = registry.capture("b")
    registry.beginRoutingModeChange()
    expect(registry.confirmedRoutingMode).toBeNull()
    expect(registry.isCurrent(first)).toBe(false)
    expect(registry.isCurrent(other)).toBe(false)

    const pending = registry.capture("a")
    registry.onModsConfigurationChanged()
    expect(registry.isCurrent(pending)).toBe(false)
  })

  it("keeps a rejected optimistic auto change unknown and fenced", () => {
    const registry = new ModelSelectionIntentRegistry()
    registry.confirmRoutingModeRead(registry.beginRoutingModeRead(), "pinned")
    const ticket = registry.beginRoutingModeChange()
    registry.finishRoutingModeChange(ticket)
    const afterFailure = registry.capture("a")
    registry.onModsConfigurationChanged()
    expect(registry.confirmedRoutingMode).toBeNull()
    expect(registry.isCurrent(afterFailure)).toBe(false)
  })

  it("confirms a successful mode change without overwriting a later choice", () => {
    const registry = new ModelSelectionIntentRegistry()
    const ticket = registry.beginRoutingModeChange()
    const newChoice = registry.capture("a")
    registry.finishRoutingModeChange(ticket, "auto")
    registry.onModsConfigurationChanged()
    expect(registry.confirmedRoutingMode).toBe("auto")
    expect(registry.isCurrent(newChoice)).toBe(true)
  })

  it("does not accept a read begun before a newer mode change", () => {
    const registry = new ModelSelectionIntentRegistry()
    const read = registry.beginRoutingModeRead()
    const change = registry.beginRoutingModeChange()
    registry.confirmRoutingModeRead(read, "auto")
    expect(registry.confirmedRoutingMode).toBeNull()
    registry.finishRoutingModeChange(change, "pinned")
    registry.confirmRoutingModeRead(read, "auto")
    expect(registry.confirmedRoutingMode).toBe("pinned")
  })

  it("does not confirm old auto from a read begun while a mode change is pending", () => {
    const registry = new ModelSelectionIntentRegistry()
    const change = registry.beginRoutingModeChange()
    const read = registry.beginRoutingModeRead()
    const held = registry.capture("a")
    registry.confirmRoutingModeRead(read, "auto")
    registry.onModsConfigurationChanged()
    expect(registry.confirmedRoutingMode).toBeNull()
    expect(registry.isCurrent(held)).toBe(false)

    registry.finishRoutingModeChange(change, "pinned")
    registry.confirmRoutingModeRead(read, "auto")
    expect(registry.confirmedRoutingMode).toBe("pinned")
    registry.confirmRoutingModeRead(registry.beginRoutingModeRead(), "auto")
    expect(registry.confirmedRoutingMode).toBe("auto")
  })

  it("rejects a read that resolves while a later change is pending", () => {
    const registry = new ModelSelectionIntentRegistry()
    const read = registry.beginRoutingModeRead()
    registry.beginRoutingModeChange()
    registry.confirmRoutingModeRead(read, "auto")
    expect(registry.confirmedRoutingMode).toBeNull()
  })

  it("lets only the latest mode ticket finish", () => {
    const registry = new ModelSelectionIntentRegistry()
    const first = registry.beginRoutingModeChange()
    const latest = registry.beginRoutingModeChange()
    registry.finishRoutingModeChange(first, "auto")
    expect(registry.confirmedRoutingMode).toBeNull()
    registry.finishRoutingModeChange(latest, "pinned")
    registry.finishRoutingModeChange(first)
    expect(registry.confirmedRoutingMode).toBe("pinned")
  })

  it("clears old thread and mode ownership while allowing StrictMode-style reuse", () => {
    const registry = new ModelSelectionIntentRegistry()
    const oldReceipt = registry.capture("a")
    const oldRead = registry.beginRoutingModeRead()
    const oldChange = registry.beginRoutingModeChange()
    registry.clear()
    expect(registry.retainedThreadCount).toBe(0)
    expect(registry.confirmedRoutingMode).toBeNull()
    expect(registry.isCurrent(oldReceipt)).toBe(false)
    expect(registry.isLifetimeCurrent(oldReceipt)).toBe(false)

    // Revision zero is reused after clear; old reads still belong to the retired lifetime.
    registry.confirmRoutingModeRead(oldRead, "auto")
    registry.finishRoutingModeChange(oldChange, "auto")
    expect(registry.confirmedRoutingMode).toBeNull()

    const newReceipt = registry.capture("a")
    const newChange = registry.beginRoutingModeChange()
    registry.confirmRoutingModeRead(oldRead, "auto")
    registry.finishRoutingModeChange(oldChange, "auto")
    expect(registry.confirmedRoutingMode).toBeNull()
    registry.finishRoutingModeChange(newChange, "pinned")
    expect(registry.confirmedRoutingMode).toBe("pinned")
    expect(registry.isLifetimeCurrent(newReceipt)).toBe(true)
    expect(newReceipt.lifetime).not.toBe(oldReceipt.lifetime)
    expect(registry.retainedThreadCount).toBe(1)
  })
})
