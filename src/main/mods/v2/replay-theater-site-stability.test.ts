import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

it("keeps the original Replay AbovePrompt quiet across host reads and real invalidations", async () => {
  const root = resolve("resources/mods/community-originals/replay-theater")
  expect(readFileSync(resolve(root, "hooks/replay-theater.mjs"))).toEqual(
    readFileSync(resolve("tests/fixtures/mods-upstream/replay-theater/hooks/replay-theater.mjs"))
  )
  const compiled = await compileFunctionPlugin(root)
  const guest = await FunctionGuestRuntime.create(compiled.code)
  const notices: unknown[] = []
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: process.cwd(),
      threadId: "replay-stability",
      assertLive: () => undefined,
      publish: async (value) => value,
      uiChanged: (scope) => {
        notices.push(scope)
      },
      authorizeProcess: async () => {
        throw Error("NO_BUSINESS_EXECUTION")
      }
    }
  )
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150))
  const props = { isWorking: false, bodyColumns: 80, maxRows: 8, offset: 0 }
  try {
    await session.start()
    const owner = await session.sites.mount("AbovePrompt")
    const first = await session.sites.render(owner, props)
    for (let i = 0; i < 5; i++) {
      expect((await session.sites.render(owner, props)).generation).toBe(first.generation)
    }
    await settle()
    expect(notices).toEqual([])
    await session.sites.render(owner, { ...props, isWorking: true })
    await settle()
    expect(notices).toEqual([])
    await session.turnStart({ turnId: "fixture", text: "synthetic edit receipt" })
    await session.interceptTool(
      {
        tool: "Edit",
        tool_use_id: "synthetic-edit",
        file_path: "never-written.txt",
        old_string: "before",
        new_string: "after",
        replace_all: false
      },
      undefined,
      async () => ({ result: "fixture", text: "fixture" })
    )
    await session.turnComplete({
      turnId: "fixture",
      answer: "done",
      durationMs: 1,
      reason: "answer",
      isAborted: false
    })
    await settle()
    // Replay owns both the AbovePrompt band and a Pane. Its SDK redraw now emits
    // these precise scopes instead of one global invalidation.
    const redrawNotices = [`site-redraw:${owner}`, "panes"]
    expect(notices).toEqual(redrawNotices)
    const replay = await session.sites.render(owner, props)
    expect(JSON.stringify(replay.tree)).toContain("Replay: 1 edit")
    await settle()
    expect(notices).toEqual(redrawNotices)
    await session.run("replay", "")
    await session.panes.snapshot()
    await settle()
    const afterOpen = [...notices]
    await session.sites.render(owner, props)
    await settle()
    expect(notices).toEqual(afterOpen)
    await session.sites.unmount(owner)
    const restored = await session.sites.mount("AbovePrompt")
    await session.sites.render(restored, props)
    await settle()
    expect(notices).toEqual(afterOpen)
  } finally {
    await session.close()
  }
}, 15000)
