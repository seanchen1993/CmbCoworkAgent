import { expect, it, vi } from "vitest"
import { COMMUNITY_EXAMPLES } from "./community-examples"
import { readCommunityExampleInstallations } from "./community-example-installations"

it("restores real installations on every read and checks identity, duplicates and changed files", async () => {
  const verify = vi.fn(async (_id: string, directory: string) => {
    if (directory === "changed") throw Error("INTEGRITY")
  })
  const plugins = [
    { id: "weather", name: "token-weather", path: "original" },
    { id: "replay", name: "replay-theater", path: "changed" }
  ]
  const read = () => readCommunityExampleInstallations(COMMUNITY_EXAMPLES, plugins, verify)
  expect((await read()).map((row) => row.installation?.state)).toEqual([
    "installed",
    "conflict",
    "missing"
  ])
  expect((await read())[0].installation).toEqual({ state: "installed", pluginId: "weather" })
  plugins.push({ id: "duplicate", name: "token-weather", path: "original" })
  expect((await read())[0].installation?.state).toBe("conflict")
  plugins.splice(0)
  expect((await read()).every((row) => row.installation?.state === "missing")).toBe(true)
})
