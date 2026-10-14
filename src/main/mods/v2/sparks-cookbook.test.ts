import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { parseProjectCapabilityManifest } from "../../../shared/project-capability"

const read = (path: string) => readFileSync(resolve(path), "utf8").replace(/\r\n/g, "\n").trim()
const tutorial = read("docs/sparks/plugin-cookbook.md")

it("keeps copyable tutorial files identical to the installable example", () => {
  const json = [...tutorial.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1])
  expect(json).toHaveLength(2)
  expect(json[0]).toBe(read("examples/sparks-hello/mods/manifest.json"))
  expect(tutorial.match(/```typescript\n([\s\S]*?)\n```/)?.[1]).toBe(
    read("examples/sparks-hello/mods/hello.ts")
  )
  expect(parseProjectCapabilityManifest(JSON.parse(json[1])).stages[0].nodeId).toBe("dev.code")
})

it("compiles and runs the beginner command in the production guest without model or file access", async () => {
  const compiled = await compileFunctionPlugin(resolve("examples/sparks-hello"))
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  try {
    expect(guest.registrations).toHaveLength(2)
    const start = guest.registrations.find((item) => item.pattern === "session.start")!
    const calls: Array<{ method: string; args: unknown }> = []
    await guest.invoke(
      start.id,
      {},
      async (method, args) => {
        calls.push({ method, args })
        return {}
      },
      {
        event: "session.start",
        origin: { plugin: "engine", tier: "core" },
        capabilities: ["command.register"],
        plugin: { name: compiled.name, root: compiled.root }
      }
    )
    expect(calls).toEqual([
      {
        method: "command.register",
        args: [expect.objectContaining({ name: "hello-spark", immediate: true })]
      },
      { method: "next", args: { input: {} } }
    ])
    const command = guest.registrations.find((item) => item.pattern === "command.run")!
    for (const [args, name] of [
      [" 小明 ", "小明"],
      ["", "新朋友"],
      ["x".repeat(100), "x".repeat(80)]
    ]) {
      const result = await guest.invoke(
        command.id,
        { command: "hello-spark", args },
        async () => {
          throw Error("The greeting must not call host services")
        },
        {
          event: "command.run",
          origin: { plugin: "engine", tier: "core" },
          capabilities: [],
          plugin: { name: compiled.name, root: compiled.root }
        }
      )
      expect(result).toMatchObject({ value: { text: `你好，${name}！第一个灵件已运行。` } })
    }
  } finally {
    guest.dispose()
  }
})
