import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { FUNCTION_CHAT_TRANSCRIPT_SITE_LIMIT } from "../../../shared/mods/v2/sites"
import { ModControlStore } from "../control-store"
import { FUNCTION_DISPLAY_PROTOCOL } from "./display-rollout"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"

it.each([
  { name: "active guest", protocol: FUNCTION_DISPLAY_PROTOCOL, hasScope: true },
  {
    name: "active guest without direct scope",
    protocol: FUNCTION_DISPLAY_PROTOCOL,
    hasScope: false
  },
  { name: "legacy peer", protocol: "legacy", hasScope: true }
])("isolates $name drawing capacity to its own thread", async ({ protocol, hasScope }) => {
  const root = await mkdtemp(join(tmpdir(), "display-site-capacity-"))
  const path = join(root, "plugin")
  const database = {}
  const control = new ModControlStore(join(root, "control.sqlite"))
  const guests: FunctionGuestRuntime[] = []
  const manager = new FunctionModsManager(
    control,
    {
      plugins: () => [
        {
          id: "source",
          name: "display",
          path,
          enabled: true,
          version: "1.0.0",
          description: "",
          author: "",
          skillCount: 0,
          mcpServerCount: 0,
          hookCount: 0,
          createdAt: "2026-10-22",
          updatedAt: "2026-10-22"
        }
      ],
      enabled: () => true,
      protects: () => true,
      captureSiteGuard: () => () => {},
      captureDisplayScope: (workspace, threadId) =>
        hasScope
          ? {
              database,
              workspace,
              threadId,
              incarnation: { token: `${threadId}:current`, legacyCreatedAt: 1 },
              assertCurrent: () => {}
            }
          : undefined,
      changed: () => {},
      publish: async (_workspace, value) => value
    },
    () => ({
      async load(code, options) {
        const guest = await FunctionGuestRuntime.create(code, options)
        guests.push(guest)
        return guest
      },
      stop() {
        for (const guest of guests) void guest.dispose()
      },
      async stopAndDrain() {
        await Promise.all(guests.map((guest) => guest.dispose()))
      }
    })
  )
  try {
    await mkdir(join(path, "mods"), { recursive: true })
    await writeFile(
      join(path, "plugin.json"),
      JSON.stringify({
        name: "display",
        version: "1.0.0",
        mods: "mods/manifest.json"
      })
    )
    await writeFile(
      join(path, "mods/manifest.json"),
      JSON.stringify({
        apiVersion: "cmb.mods/v2",
        id: "display",
        entry: "main.ts"
      })
    )
    await writeFile(
      join(path, "mods/main.ts"),
      `
      export function register(on) {
        let pressed = 0;
        on("ui.render", {component:"AssistantMessage"}, ($,e) =>
          $.ui.resolve(e).Button({key:"press",label:e.props.text + " / " + pressed,
            onPress(){pressed++;$.ui.invalidate("ui.render")}}))
      }
    `
    )
    const [status] = await manager.status(root)
    expect(status.state, status.error).toBe("needs-approval")
    await manager.approve(root, "source", status.digest!)

    const read = (threadId: string, row: number) =>
      manager.siteRead(
        root,
        threadId,
        "AssistantMessage",
        { text: `message ${row}`, isFirstOfReply: true },
        `row:${row}`,
        undefined,
        undefined,
        protocol
      )
    const mount = async (threadId: string, row: number, pressed = 0) => {
      const result = await read(threadId, row)
      if (result.state !== "mounted") throw Error(`Expected a drawing, got ${result.state}`)
      const snapshot = result.snapshot
      if (snapshot.tree.type !== "Button" || !snapshot.tree.press)
        throw Error("Missing drawn Button")
      expect(snapshot.tree.props.label).toBe(`message ${row} / ${pressed}`)
      return { owner: result.owner, snapshot, press: snapshot.tree.press }
    }

    const owners: string[] = []
    // More active drawings than the old one-type limit, with the last button still actionable.
    for (let row = 0; row < 47; row++) owners.push((await mount("first", row)).owner)
    const active = await mount("first", 47)
    owners.push(active.owner)
    for (let row = owners.length; row < FUNCTION_CHAT_TRANSCRIPT_SITE_LIMIT; row++) {
      const outcome = await manager.siteMountOutcome(root, "first", "AssistantMessage")
      if (outcome.state !== "mounted") throw Error(`Expected a slot, got ${outcome.state}`)
      owners.push(outcome.owner)
    }
    const overflow = FUNCTION_CHAT_TRANSCRIPT_SITE_LIMIT
    expect(new Set(owners).size).toBe(overflow)
    await expect(read("first", overflow)).rejects.toThrow("MODS_UI_SITE_LIMIT")

    const { owner: second } = await mount("second", 0)
    expect(owners).not.toContain(second)
    await expect(manager.siteUnmount(root, "second", active.owner)).resolves.toBeUndefined()
    await expect(read("first", overflow)).rejects.toThrow("MODS_UI_SITE_LIMIT")
    const press = {
      pane: active.snapshot.key,
      generation: active.snapshot.generation,
      intentId: randomUUID(),
      plugin: active.press.plugin,
      handle: active.press.handle,
      kind: "press" as const
    }
    await expect(manager.siteAct(root, "second", active.owner, press)).rejects.toThrow(
      "MODS_UI_SITE_CLOSED"
    )
    await manager.siteAct(root, "first", active.owner, press)

    await manager.siteUnmount(root, "first", active.owner)
    expect((await mount("first", overflow, 1)).owner).not.toBe(active.owner)
    await expect(read("first", overflow + 1)).rejects.toThrow("MODS_UI_SITE_LIMIT")
    expect((await mount("second", 1)).owner).not.toBe(second)
  } finally {
    manager.close()
    await Promise.all(guests.map((guest) => guest.dispose()))
    control.close()
    await rm(root, { recursive: true, force: true })
  }
})
