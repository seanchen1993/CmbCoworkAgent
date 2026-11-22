import { describe, expect, it, vi } from "vitest"
const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock("electron", () => ({ ipcRenderer: ipc }))
import { localBotsApi } from "../../preload/bots"

describe("named local Bot reaction bridge", () => {
  it("forwards the exact target/message/state through the two narrow local channels", async () => {
    const target = { kind: "bot" as const, botId: "bot", workId: "work" }
    await localBotsApi.messageReactions(target, ["native:id"])
    expect(ipc.invoke).toHaveBeenCalledWith("bots:message-reactions", "local", target, [
      "native:id"
    ])
    await localBotsApi.setMessageReaction(
      { kind: "group", groupId: "group" },
      "public-id",
      "🎉",
      false
    )
    expect(ipc.invoke).toHaveBeenCalledWith(
      "bots:set-message-reaction",
      "local",
      { kind: "group", groupId: "group" },
      "public-id",
      "🎉",
      false
    )
  })
})
