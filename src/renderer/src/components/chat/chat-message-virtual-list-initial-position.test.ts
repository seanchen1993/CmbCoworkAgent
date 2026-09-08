import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
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
      resolveChatMessageVirtualInitialLocation(
        { index: 500, align: "end", behavior: "auto" },
        201
      )
    ).toEqual({ index: 200, align: "end", behavior: "auto" })
  })

  it("keeps initial positioning mount-scoped without replacing list layout contracts", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("./ChatMessageVirtualList.tsx", import.meta.url)
      ),
      "utf8"
    )

    expect(source).toMatch(/key=\{threadId\}/)
    expect(source).toMatch(
      /initialTopMostItemIndex=\{resolvedInitialTopMostItemIndex\}/
    )
    expect(source).toMatch(/context=\{\{ header: historyHeader, footer: footerContent \}\}/)
    expect(source).toMatch(/return message \? `\$\{message\.role\}:\$\{message\.id\}`/)
    expect(source).toMatch(/totalListHeightChanged=\{onContentHeightChanged\}/)
    expect(source).toMatch(/followOutput=\{\(\) => false\}/)
  })
})
