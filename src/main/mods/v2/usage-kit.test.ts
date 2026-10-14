import { resolve } from "node:path"
import { expect, it } from "vitest"
import { compileFunctionPlugin, projectFunctionComponents } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"

it("the shipped usage component compiles and updates its real pane from a native notification", async () => {
  const compiled = await compileFunctionPlugin(resolve("examples/mods-usage-notice"))
  const projected = projectFunctionComponents(compiled, { mode: "all", ids: [], config: {} })
  const guest = await FunctionGuestRuntime.create(projected.code, projected.options)
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/usage",
      threadId: "thread",
      assertLive: () => undefined,
      publish: async (value) => value,
      readSession: async () => ({ context: { window: 1000 }, rateLimits: [] })
    }
  )
  const text = (value: string | FunctionUiElement): string => {
    if (typeof value === "string") return value
    if (value.type === "engine") return ""
    return (value.children ?? []).map(text).join("")
  }
  try {
    await session.start()
    await session.run("usage-board", "")
    expect(text((await session.panes.snapshot())[0].tree)).toContain("等待实际任务")
    await session.measure(
      async () => ({ context: { window: 1000, tokens: 250, percent: 25 }, rateLimits: [] }),
      new AbortController().signal,
      () => undefined
    )
    expect(text((await session.panes.snapshot())[0].tree)).toContain("250 / 1000")
  } finally {
    await session.close()
  }
})
