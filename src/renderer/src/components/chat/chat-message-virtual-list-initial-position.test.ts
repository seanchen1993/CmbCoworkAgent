import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { resolveChatSessionInitialLocation } from "./chat-session-initial-location"
import {
  CHAT_MESSAGE_VIRTUALIZATION_THRESHOLD,
  resolveChatMessageVirtualInitialLocation,
  shouldVirtualizeChatMessageList,
  type ChatMessageVirtualInitialLocation
} from "./ChatMessageVirtualList"

describe("chat message virtual list initial location", () => {
  it("keeps a non-empty conversation on one virtual list across 99/100/101", () => {
    expect(CHAT_MESSAGE_VIRTUALIZATION_THRESHOLD).toBe(100)
    expect(shouldVirtualizeChatMessageList(0)).toBe(false)
    expect(shouldVirtualizeChatMessageList(1)).toBe(true)
    expect(shouldVirtualizeChatMessageList(99)).toBe(true)
    expect(shouldVirtualizeChatMessageList(100)).toBe(true)
    expect(shouldVirtualizeChatMessageList(101)).toBe(true)
  })

  it("does not manufacture a location while async message data is empty", () => {
    const location: ChatMessageVirtualInitialLocation = {
      index: "LAST",
      align: "end",
      behavior: "auto"
    }

    expect(resolveChatMessageVirtualInitialLocation(location, 0)).toBeUndefined()
    expect(resolveChatMessageVirtualInitialLocation(location, 101)).toBe(location)
  })

  it("clamps a numeric location against the newly mounted thread projection", () => {
    expect(resolveChatMessageVirtualInitialLocation(-2, 101)).toBe(0)
    expect(resolveChatMessageVirtualInitialLocation(100, 101)).toBe(100)
    expect(resolveChatMessageVirtualInitialLocation(500, 101)).toBe(100)
    expect(
      resolveChatMessageVirtualInitialLocation({ index: 500, align: "end", behavior: "auto" }, 201)
    ).toEqual({ index: 200, align: "end", behavior: "auto" })
  })

  it("keeps initial positioning mount-scoped without replacing list layout contracts", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./ChatMessageVirtualList.tsx", import.meta.url)),
      "utf8"
    )

    expect(source).toMatch(/key=\{virtualWindow\.key\}/)
    expect(source).toMatch(/firstItemIndex=\{virtualWindow\.firstItemIndex\}/)
    expect(source).toMatch(/initialTopMostItemIndex=\{resolvedInitialTopMostItemIndex\}/)
    expect(source).toMatch(
      /context=\{\{\s*header:\s*<>\{historyHeader\}\s*<FunctionPlacedRows\s+threadId=\{threadId\}\s+rows=\{placedRows\.start\}\s*\/>\s*<\/>,\s*footer: footerContent,/
    )
    expect(source).toMatch(
      /windowKey: virtualWindow\.key,\s*firstItemIndex: virtualWindow\.firstItemIndex,/
    )
    expect(source).toMatch(/scrollParent: customScrollParent\s*\}\}/)
    expect(source).toMatch(/computeItemKey=\{\(_index, row\) => row\.identity\}/)
    expect(source).toMatch(/totalListHeightChanged=\{onContentHeightChanged\}/)
    expect(source).toMatch(/followOutput=\{false\}/)
  })
})

describe("restored session initial location", () => {
  const indexes = new Map([["anchor", 37]])
  const seed = { threadId: "one", messageId: "anchor", offsetFromViewportTop: 28 }

  it("uses the current window's relative index and the inverse saved offset", () => {
    expect(resolveChatSessionInitialLocation("one", "detached", seed, indexes))
      .toEqual({ index: 37, align: "start", behavior: "auto", offset: -28 })
    expect(resolveChatSessionInitialLocation("one", "detached",
      { ...seed, offsetFromViewportTop: -90 }, indexes)?.offset).toBe(90)
  })

  it("does not replay a cleared restore on another window or another thread", () => {
    expect(resolveChatSessionInitialLocation("two", "detached", seed, indexes)).toBeUndefined()
    expect(resolveChatSessionInitialLocation("one", "detached", null, indexes)).toBeUndefined()
    expect(resolveChatSessionInitialLocation("one", "detached", seed, new Map())).toBeUndefined()
  })

  it("keeps following, fresh initialization and active history restoration on their own paths", () => {
    for (const mode of ["following", "initializing", "restoring"] as const)
      expect(resolveChatSessionInitialLocation("one", mode, seed, indexes)).toBeUndefined()
    for (const offsetFromViewportTop of [NaN, Infinity, -Infinity])
      expect(resolveChatSessionInitialLocation("one", "detached",
        { ...seed, offsetFromViewportTop }, indexes)).toBeUndefined()
  })
})
