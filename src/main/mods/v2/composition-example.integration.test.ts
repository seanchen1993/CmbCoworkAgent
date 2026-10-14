import { resolve } from "node:path"
import { expect, it } from "vitest"
import { isModObject, type FunctionHostCall } from "../../../shared/mods/v2/contracts"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { validateFunctionTree } from "../../../shared/mods/v2/ui"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSharedWallCut } from "./shared-wall-cut"
import { FunctionUiResolveUtilityAssembly } from "./ui-resolve-utility-assembly"

function nodes(value: ModJson | undefined): ModObject[] {
  if (!isModObject(value)) return []
  return [value, ...(Array.isArray(value.children) ? value.children.flatMap(nodes) : [])]
}

// Compiles the actual distributed examples and uses their real QuickJS closures. Desktop ZIP
// installation, main permissions and actual clicks are covered separately by the Electron suite.
it("the two author examples combine real constructors and retain the board's original action", async () => {
  for (const styled of [false, true]) {
    const compiled = await Promise.all(
      ["mods-composition-board", ...(styled ? ["mods-composition-style"] : [])].map((name) =>
        compileFunctionPlugin(resolve("examples", name))
      )
    )
    const guests: FunctionGuestRuntime[] = []
    let assembly: FunctionUiResolveUtilityAssembly | undefined
    const hostCalls: Array<{ method: string; args: unknown }> = []
    const host: FunctionHostCall = async (method, args) => {
      hostCalls.push({ method, args })
      return { value: {} }
    }
    try {
      for (const plugin of compiled) guests.push(await FunctionGuestRuntime.create(plugin.code))
      let revision = 1
      assembly = new FunctionUiResolveUtilityAssembly({
        identity: Object.freeze({}),
        assembly: "author-example",
        requestId: "prepare-example",
        participants: guests.map((guest, index) => ({
          runtimeId: compiled[index].name,
          guest,
          declaration: {
            runtimeId: compiled[index].name,
            name: compiled[index].name,
            root: compiled[index].root,
            tier: "user",
            modelProtocol: "result-v1",
            capabilities: ["ui.resolve"],
            registrations: [...guest.registrations]
          },
          assertCurrent() {
            if (guest.stats.disposed) throw new Error("Actual example disposed")
          }
        })),
        credit: { revision, limits: { handles: 0, roots: 0, branches: 0, reactions: 0 } },
        startupCutNs: FunctionSharedWallCut.after(120000).expiresAtNs,
        signal: new AbortController().signal,
        host: {
          assertCurrent() {
            /* This fixture has no external source changes. */
          },
          publish() {
            /* Wire transport is verified by the separate Electron suite. */
          },
          async call() {
            throw new Error("Style example cannot invent an SDK call")
          },
          async requestCredit(limits) {
            return { revision: ++revision, limits: { ...limits } }
          }
        }
      })
      const prepared = await assembly.prepare()
      assembly.adopt(prepared.preparedToken)
      const board = guests[0]
      const plugin = { name: compiled[0].name, root: compiled[0].root }
      const origin = { plugin: "host", tier: "core" as const }
      await board.invoke("0", {}, host, {
        event: "session.start",
        plugin,
        origin,
        capabilities: ["command.register"]
      })
      expect(hostCalls.some((row) => row.method === "command.register")).toBe(true)
      await board.invoke("1", { command: "claw-board", input: "" }, host, {
        event: "command.run",
        plugin,
        origin,
        capabilities: ["ui.open"]
      })
      expect(hostCalls.some((row) => row.method === "ui.open")).toBe(true)
      const render = async (generation: string) => {
        const result = await board.invoke(
          "2",
          { surface: "desktop", component: "Pane", requestId: "composition-board", props: {} },
          host,
          {
            event: "ui.render",
            plugin,
            origin,
            uiGeneration: generation,
            capabilities: ["ui.resolve", "ui.invalidate"]
          },
          { assembly: "author-example", token: generation }
        )
        validateFunctionTree(result.value)
        return result.value
      }
      const first = await render("example-1")
      const button = nodes(first).find((node) => node.type === "Button")
      if (!button || !isModObject(button.props) || !isModObject(button.press))
        throw new Error("Example must publish an actual original board action")
      expect(button.props.label).toBe(styled ? "执行 · 完成一次操作" : "完成一次操作")
      expect(button.press.plugin).toBe(compiled[0].name)
      expect(JSON.stringify(first).includes("组合版 · ")).toBe(styled)
      await board.invoke(
        "callback",
        {
          surface: "desktop",
          component: "Pane",
          requestId: "composition-board",
          plugin: compiled[0].name,
          element: "complete-one"
        },
        host,
        {
          event: "ui.press",
          plugin,
          origin,
          capabilities: ["ui.invalidate"],
          callback: {
            handle: Number(button.press.handle),
            generation: "example-1",
            kind: "onPress"
          }
        }
      )
      expect(hostCalls.filter((row) => row.method === "ui.invalidate")).toHaveLength(1)
      assembly.closeDrawing("example-1")
      const second = await render("example-2")
      expect(JSON.stringify(second)).toContain("已完成 1 次操作")
      expect(nodes(second).filter((node) => node.type === "Button")).toHaveLength(1)
    } finally {
      assembly?.retire()
      for (const guest of guests.reverse()) guest.dispose()
    }
  }
}, 10000)
