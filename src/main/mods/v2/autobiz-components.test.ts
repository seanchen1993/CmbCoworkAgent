import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { compileFunctionPlugin, projectFunctionComponents } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"

const roots: string[] = []
const guests: FunctionGuestRuntime[] = []
afterEach(async () => {
  guests.splice(0).forEach((guest) => guest.dispose())
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it("compiles the real Autobiz component wrappers and registers only selected status commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-autobiz-components-"))
  roots.push(root)
  await cp(resolve("examples/autobiz-kanban-mods"), root, { recursive: true })
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({
      name: "AutobizDevOps_Plugin_Kanban_Mods",
      version: "1.5.0",
      mods: "mods/manifest.json"
    })
  )
  const manifest = JSON.parse(await readFile(join(root, "mods/manifest.json"), "utf8"))
  manifest.claw.actions = JSON.parse(
    await readFile(join(root, "claw-actions.json"), "utf8")
  ).actions
  await writeFile(join(root, "mods/manifest.json"), JSON.stringify(manifest))
  // Generated workflow data is not consulted by session registration in this contract test.
  await writeFile(join(root, "hooks/kanban/workflow.generated.ts"), "export const variants = {}")
  const compiled = await compileFunctionPlugin(root)
  expect(compiled.components).toHaveLength(5)
  const full = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  guests.push(full)
  expect(full.registrations.some((row) => row.pattern === "completion.check")).toBe(true)
  const status = projectFunctionComponents(compiled, {
    mode: "selected",
    ids: ["status"],
    config: {}
  })
  const guest = await FunctionGuestRuntime.create(status.code, status.options)
  guests.push(guest)
  expect(status.actions).toEqual([])
  expect(guest.registrations.some((row) => row.pattern === "completion.check")).toBe(false)
  const registration = guest.registrations.find((row) => row.pattern === "session.start")!
  const commands: string[] = []
  await guest.invoke(
    registration.id,
    {},
    async (method, args) => {
      if (method === "next") return { value: {} }
      expect(method).toBe("command.register")
      if (!Array.isArray(args)) throw Error("Expected command registration argv")
      commands.push((args[0] as { name: string }).name)
      return { value: null }
    },
    {
      event: "session.start",
      origin: { plugin: "engine", tier: "core" },
      capabilities: ["command.register"],
      plugin: { name: compiled.name, root }
    }
  )
  expect(commands).toEqual(["kanban-check"])
  expect(() =>
    projectFunctionComponents(compiled, { mode: "selected", ids: ["board"], config: {} })
  ).toThrow()
  expect(
    projectFunctionComponents(compiled, {
      mode: "selected",
      ids: ["review-input"],
      config: {}
    }).actions.map((action) => action.id)
  ).toEqual(["prepare-review"])
})
