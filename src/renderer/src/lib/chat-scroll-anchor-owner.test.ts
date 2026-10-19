import { describe, expect, it } from "vitest"
import { claimVirtualizedChatScrollAnchor } from "./chat-scroll-anchor-owner"

function makeViewport(value = "", priority = "") {
  const declarations = new Map<string, { value: string; priority: string }>()
  if (value) declarations.set("overflow-anchor", { value, priority })
  const viewport = {
    style: {
      getPropertyValue(name: string) { return declarations.get(name)?.value ?? "" },
      getPropertyPriority(name: string) { return declarations.get(name)?.priority ?? "" },
      setProperty(name: string, next: string | null, nextPriority = "") {
        if (next) declarations.set(name, { value: next, priority: nextPriority })
        else declarations.delete(name)
      },
      removeProperty(name: string) {
        const previous = declarations.get(name)?.value ?? ""
        declarations.delete(name)
        return previous
      }
    }
  }
  return { viewport, declaration: () => declarations.get("overflow-anchor") }
}

describe("virtualized chat viewport anchor ownership", () => {
  it("owns only anchoring and restores the original inline value and priority", () => {
    const { viewport, declaration } = makeViewport("auto", "important")
    viewport.style.setProperty("color", "red")
    const release = claimVirtualizedChatScrollAnchor(viewport)
    expect(declaration()).toEqual({ value: "none", priority: "important" })
    expect(viewport.style.getPropertyValue("color")).toBe("red")
    release()
    expect(declaration()).toEqual({ value: "auto", priority: "important" })
    expect(viewport.style.getPropertyValue("color")).toBe("red")
  })

  it("removes the owned declaration when the viewport originally had no inline value", () => {
    const { viewport, declaration } = makeViewport()
    const release = claimVirtualizedChatScrollAnchor(viewport)
    expect(declaration()).toEqual({ value: "none", priority: "" })
    release()
    expect(declaration()).toBeUndefined()
  })

  it("does not let an older cleanup overwrite a newer owner of the same viewport", () => {
    const { viewport, declaration } = makeViewport("auto", "important")
    const old = claimVirtualizedChatScrollAnchor(viewport)
    const current = claimVirtualizedChatScrollAnchor(viewport)
    old()
    expect(declaration()).toEqual({ value: "none", priority: "important" })
    current()
    expect(declaration()).toEqual({ value: "auto", priority: "important" })
    old()
    expect(declaration()).toEqual({ value: "auto", priority: "important" })
  })

  it("keeps a different viewport outside the ownership boundary", () => {
    const first = makeViewport(), other = makeViewport("auto")
    const release = claimVirtualizedChatScrollAnchor(first.viewport)
    expect(other.declaration()).toEqual({ value: "auto", priority: "" })
    release()
  })

  it("keeps anchoring disabled when the newer overlapping lease releases first", () => {
    const { viewport, declaration } = makeViewport("auto", "important")
    const older = claimVirtualizedChatScrollAnchor(viewport)
    const newer = claimVirtualizedChatScrollAnchor(viewport)
    newer()
    expect(declaration()).toEqual({ value: "none", priority: "important" })
    older()
    expect(declaration()).toEqual({ value: "auto", priority: "important" })
  })

  it("does not restore over a later external inline declaration", () => {
    const { viewport, declaration } = makeViewport()
    const release = claimVirtualizedChatScrollAnchor(viewport)
    viewport.style.setProperty("overflow-anchor", "auto", "important")
    release()
    expect(declaration()).toEqual({ value: "auto", priority: "important" })
  })

  it("inherits a newer external declaration when another chat owner claims the viewport", () => {
    const { viewport, declaration } = makeViewport()
    const old = claimVirtualizedChatScrollAnchor(viewport)
    viewport.style.setProperty("overflow-anchor", "auto", "important")
    const current = claimVirtualizedChatScrollAnchor(viewport)
    old()
    expect(declaration()).toEqual({ value: "none", priority: "important" })
    current()
    expect(declaration()).toEqual({ value: "auto", priority: "important" })
  })

  it("makes completed cleanup idempotent without removing a later declaration", () => {
    const { viewport, declaration } = makeViewport()
    const release = claimVirtualizedChatScrollAnchor(viewport)
    release()
    viewport.style.setProperty("overflow-anchor", "none", "important")
    release()
    expect(declaration()).toEqual({ value: "none", priority: "important" })
  })
})
