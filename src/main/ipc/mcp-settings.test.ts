import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IpcMain } from "electron"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ app: {} }))
const invalidate = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("../mcp/capability-service", () => ({ invalidateGlobalMcpCapabilityService: invalidate }))

let directory: string
let storage: typeof import("../storage")
let handlers: Map<string, (event: unknown, input: unknown) => Promise<unknown>>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cmb-mcp-settings-"))
  vi.stubEnv("CMB_COWORK_AGENT_HOME", directory)
  vi.resetModules()
  invalidate.mockReset().mockResolvedValue(undefined)
  storage = await import("../storage")
  handlers = new Map()
  const { registerMcpHandlers } = await import("./mcp")
  registerMcpHandlers({
    handle: (name: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
      handlers.set(name, handler)
    }
  } as unknown as IpcMain)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(directory, { recursive: true, force: true })
})

it.each(["enabled", "lazyLoad"] as const)(
  "changes only %s and rejects invalid or deleted targets",
  async (key) => {
    const id = storage.upsertMcpConnector({
      name: "Latest configuration",
      kind: "stdio",
      command: "node",
      args: ["current.js"],
      env: { FIXTURE: "preserve" },
      enabled: true,
      lazyLoad: false
    })
    const previous = storage.getMcpConnectors()[0]
    const channel = key === "enabled" ? "mcp:setEnabled" : "mcp:setLazyLoad"
    const handler = handlers.get(channel)!
    const changed = !previous[key]
    for (const input of [
      null,
      {},
      { id: "", [key]: changed },
      { id, [key]: "true" },
      { id, [key]: changed, command: "overwrite.js" }
    ]) {
      await expect(handler({}, input)).rejects.toThrow()
    }
    expect(storage.getMcpConnectors()).toEqual([previous])
    expect(invalidate).not.toHaveBeenCalled()
    await handler({}, { id, [key]: changed })
    expect(storage.getMcpConnectors()).toEqual([
      { ...previous, [key]: changed, updatedAt: expect.any(String) }
    ])
    expect(invalidate).toHaveBeenCalledWith(channel)
    storage.deleteMcpConnector(id)
    await expect(handler({}, { id, [key]: changed })).rejects.toThrow("不存在")
    expect(storage.getMcpConnectors()).toEqual([])
  }
)

it("waits for capability publication and retries it without rewriting an already saved flag", async () => {
  const id = storage.upsertMcpConnector({
    name: "Readback",
    url: "https://fixture.invalid/mcp",
    lazyLoad: false
  })
  let release!: () => void
  invalidate.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  let acknowledged = false
  const pending = handlers.get("mcp:setLazyLoad")!({}, { id, lazyLoad: true }).then(() => {
    acknowledged = true
  })
  expect(storage.getMcpConnectors()[0].lazyLoad).toBe(true)
  await Promise.resolve()
  expect(acknowledged).toBe(false)
  release()
  await pending
  invalidate.mockRejectedValueOnce(new Error("publication interrupted"))
  await expect(handlers.get("mcp:setEnabled")!({}, { id, enabled: false })).rejects.toThrow(
    "publication interrupted"
  )
  expect(storage.getMcpConnectors()[0].enabled).toBe(false)
  const file = join(directory, "mcp-connectors.json")
  const saved = await readFile(file, "utf8")
  await handlers.get("mcp:setEnabled")!({}, { id, enabled: false })
  expect(await readFile(file, "utf8")).toBe(saved)
  expect(invalidate).toHaveBeenCalledTimes(3)
})
