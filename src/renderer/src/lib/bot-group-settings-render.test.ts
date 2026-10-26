import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { BotClient, BotGroup } from "../../../shared/bots/contracts"

vi.mock("@/components/ui/dialog", () => {
  const content = ({ children }: { children: unknown }) => children
  return {
    Dialog: content,
    DialogContent: content,
    DialogDescription: content,
    DialogFooter: content,
    DialogHeader: content,
    DialogTitle: content
  }
})
vi.mock("../components/bots/BotDeleteDialog", () => ({ BotDeleteDialog: () => null }))
vi.mock("../components/bots/BotAvatar", () => ({ BotAvatar: () => null }))
import { BotGroupEditor } from "../components/bots/BotGroupEditor"

afterEach(() => vi.unstubAllGlobals())
const group = {
  id: "history",
  hostId: "local",
  name: "Retained history",
  memberIds: [],
  version: 3
} satisfies BotGroup
const render = (value: BotGroup | null, nameOnly = true) => {
  vi.stubGlobal("document", { activeElement: null })
  return renderToStaticMarkup(
    createElement(BotGroupEditor, {
      group: value,
      bots: [],
      client: {} as BotClient,
      nameOnly,
      onClose() {},
      onSaved() {}
    })
  )
}

describe("group metadata editor", () => {
  it("allows an existing empty historical group to save its name in either editor mode", () => {
    for (const nameOnly of [true, false]) {
      const html = render(group, nameOnly)
      expect(html).toMatch(/<button[^>]*>保存<\/button>/)
      expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/)
    }
  })
  it("keeps empty creation and blank names disabled", () => {
    for (const value of [null, { ...group, name: "  " }])
      expect(render(value, false)).toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/)
  })
  it("keeps ordinary populated group renaming available", () => {
    expect(render({ ...group, memberIds: ["member"] })).not.toMatch(
      /<button[^>]*disabled=""[^>]*>保存<\/button>/
    )
  })
})
