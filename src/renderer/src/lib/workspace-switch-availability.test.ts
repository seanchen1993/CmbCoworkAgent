import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { canChangeThreadWorkspace } from "./workspace-switch-availability"

describe("workspace switch availability", () => {
  it("fails closed before a thread state exists", () => {
    expect(canChangeThreadWorkspace(undefined)).toBe(false)
  })

  it("fails closed while durable history is loading even if resident messages are empty", () => {
    expect(
      canChangeThreadWorkspace({
        historyLoading: true,
        historyConversationPresence: "empty",
        messages: []
      })
    ).toBe(false)
  })

  it("fails closed when a virtualized conversation has no resident messages", () => {
    expect(
      canChangeThreadWorkspace({
        historyLoading: false,
        historyConversationPresence: "nonempty",
        messages: []
      })
    ).toBe(false)
  })

  it("fails closed while durable conversation presence is unknown", () => {
    expect(
      canChangeThreadWorkspace({
        historyLoading: false,
        historyConversationPresence: "unknown",
        messages: []
      })
    ).toBe(false)
  })

  it("allows internal-only durable rows after presence confirms an empty conversation", () => {
    expect(
      canChangeThreadWorkspace({
        historyLoading: false,
        historyConversationPresence: "empty",
        messages: []
      })
    ).toBe(true)
    expect(
      canChangeThreadWorkspace({
        historyLoading: false,
        historyConversationPresence: "empty",
        messages: [{}]
      })
    ).toBe(false)
  })

  it("wires both FilesystemPanel selector branches to the tri-state guard", () => {
    const source = readFileSync(
      new URL("../components/panels/FilesystemPanel.tsx", import.meta.url),
      "utf8"
    ).replace(/\r\n/g, "\n")

    expect(source).toContain(
      "const canChangeWorkspace = canChangeThreadWorkspace(threadState ?? undefined)"
    )
    expect(source).toContain("!canChangeWorkspace ||")
    expect(source).toContain("!setWorkspaceFiles")
    expect(source.match(/\{canChangeWorkspace && \(/g)).toHaveLength(1)
    expect(source).toContain("{canChangeWorkspace && !isWorktree && (")
    expect(source).not.toContain("messages.length === 0")
  })
})
