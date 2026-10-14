import { resolve } from "node:path"
import { expect, it } from "vitest"
import { compileFunctionPlugin, projectFunctionComponents } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { ModObject } from "../../../shared/mods/types"

it("the shipped DIY components really select editing separately from the suggestion command", async () => {
  const compiled = await compileFunctionPlugin(resolve("examples/mods-input-kit"))
  const make = async (ids: string[]) => {
    const selected = projectFunctionComponents(compiled, { mode: "selected", ids, config: {} })
    const guest = await FunctionGuestRuntime.create(selected.code, selected.options)
    return new FunctionSession(
      [
        {
          name: compiled.name,
          root: compiled.root,
          tier: "user",
          guest,
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      { workspace: "/input-kit", threadId: "kit", assertLive() {}, publish: async (value) => value }
    )
  }
  const editor = await make(["editor"]),
    suggestion = await make(["suggestion"])
  try {
    await editor.start()
    await suggestion.start()
    expect((await editor.commands()).map((row) => row.name)).not.toContain("input-next")
    expect((await suggestion.commands()).map((row) => row.name)).toContain("input-next")
    const input = {
      origin: { kind: "composer" },
      text: "",
      cursor: 0,
      start: 0,
      end: 0,
      inputText: "review"
    }
    const core = async (edit: ModObject) => ({
      text: String(edit.inputText),
      cursor: String(edit.inputText).length
    })
    const signal = new AbortController().signal
    expect(await editor.promptEditing(input, signal, core)).toMatchObject({
      text: "REVIEW",
      decorations: [{ start: 0, end: 5, color: "warning", underline: true }]
    })
    expect(await suggestion.promptEditing(input, signal, core)).toEqual({
      text: "review",
      cursor: 6
    })
  } finally {
    await editor.close()
    await suggestion.close()
  }
})
