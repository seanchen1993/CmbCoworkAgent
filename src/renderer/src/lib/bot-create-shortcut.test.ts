import { expect, it } from "vitest"
import { botCreateShortcut } from "./bot-create-shortcut"

const key = {
  key: "n",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  isComposing: false,
  keyCode: 78,
  defaultPrevented: false
}

it("accepts Mac Command and Windows Control without stealing other commands", () => {
  expect(botCreateShortcut({ ...key, metaKey: true })).toBe("bot")
  expect(botCreateShortcut({ ...key, key: "N", ctrlKey: true })).toBe("bot")
  expect(botCreateShortcut({ ...key, metaKey: true, shiftKey: true })).toBe("chat")
  expect(botCreateShortcut({ ...key, ctrlKey: true, shiftKey: true })).toBe("chat")
  expect(botCreateShortcut(key)).toBeNull()
  expect(botCreateShortcut({ ...key, metaKey: true, key: "k" })).toBeNull()
  expect(botCreateShortcut({ ...key, ctrlKey: true, altKey: true })).toBeNull()
})

it.each([{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }])(
  "leaves native composition and already handled input alone: %j",
  (patch) => {
    expect(botCreateShortcut({ ...key, metaKey: true, ...patch })).toBeNull()
    expect(botCreateShortcut({ ...key, metaKey: true, shiftKey: true, ...patch })).toBeNull()
  }
)
