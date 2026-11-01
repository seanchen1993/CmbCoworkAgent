import { Children, isValidElement, type ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"
import type { BotClient, BotDefinition, BotMemory } from "../../../shared/bots/contracts"

const state = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }))
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [state.index < state.values.length ? state.values[state.index++] : initial, () => {}],
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
  useId: () => "memory-description"
}))
import { BotMemoryPanel } from "../components/bots/BotMemoryPanel"

function find(element: unknown, type: string): ReactElement<Record<string, any>> | undefined {
  if (!isValidElement<Record<string, any>>(element)) return undefined
  if (element.type === type) return element
  for (const child of Children.toArray(element.props.children)) {
    const match = find(child, type)
    if (match) return match
  }
  return undefined
}

describe("Bot owner memory editor", () => {
  const entry: BotMemory = {
    id: "memory", name: "Retained", content: "Fact", version: "version",
    scope: { kind: "group", groupId: "deleted-group" }
  }
  it.each([
    { editing: entry, kind: "group", groupId: undefined, scope: undefined },
    { editing: entry, kind: "private", groupId: undefined, scope: { kind: "private" } },
    { editing: entry, kind: "shared", groupId: undefined, scope: { kind: "shared" } },
    { editing: entry, kind: "group", groupId: "different-group", scope: { kind: "group", groupId: "different-group" } },
    { editing: "new", kind: "group", groupId: "current-group", scope: { kind: "group", groupId: "current-group" } },
    { editing: "new", kind: "private", groupId: undefined, scope: { kind: "private" } }
  ])("preserves or explicitly changes memory scope: %o", async ({ editing, kind, groupId, scope }) => {
    state.index = 0
    state.values = [[entry], editing, kind, "Name", "Content"]
    const writeMemory = vi.fn(async () => entry), listMemory = vi.fn(async () => [entry])
    const client = { hostId: "local", writeMemory, listMemory } as unknown as BotClient
    const tree = BotMemoryPanel({ bot: { id: "bot" } as BotDefinition, client, peers: [], groupId })
    find(tree, "form")!.props.onSubmit({ preventDefault: () => {} })
    await vi.waitFor(() => expect(listMemory).toHaveBeenCalledWith("bot", groupId))
    const input = writeMemory.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(input[0]).toBe("bot")
    expect(input[1]).toMatchObject({ name: "Name", content: "Content" })
    if (scope) expect(input[1].scope).toEqual(scope)
    else expect(input[1]).not.toHaveProperty("scope")
    if (editing !== "new") expect(input[1]).toMatchObject({ id: entry.id, expectedVersion: entry.version })
    else expect(input[1]).not.toHaveProperty("id")
  })
})
