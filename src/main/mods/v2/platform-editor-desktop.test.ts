import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ModsManager } from "../manager"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import type { EditorNavigationBroker, EditorNavigationRequest } from "./platform-editor-navigation"

const mocks = vi.hoisted(() => ({
  probe: vi.fn(async () => ({ decision: "allow" })),
  preference: "vscode" as string | null,
  open: vi.fn(async () => ({ editor: "configured-host-editor", mode: "workspace+file+line" }))
}))
vi.mock("../../agent/local-sandbox", () => ({
  LocalSandbox: { createPermissionProbe: () => mocks.probe }
}))
vi.mock("../../storage", () => ({
  getWindowsSandboxMode: () => "none",
  getPreferredIde: () => mocks.preference
}))
vi.mock("../../utils/open-in-ide", () => ({ openIde: mocks.open }))
import { createDesktopEditorPlatformProvider } from "./platform-editor-desktop"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  mocks.probe.mockReset().mockResolvedValue({ decision: "allow" })
  mocks.open.mockClear()
  mocks.preference = "vscode"
})
async function fixture(withSpace = false) {
  const workspace = await mkdtemp(join(tmpdir(), withSpace ? "editor desktop-" : "editor-desktop-"))
  roots.push(workspace)
  await writeFile(join(workspace, "source.ts"), "const source = true\n")
  const runtimeQuery = vi.fn(async () => ({ decision: "allow" }))
  const runtime = { assertLive: vi.fn(), bound: true, queryTool: runtimeQuery }
  const manager = { functionRuntimeScope: () => runtime } as unknown as ModsManager
  const requests: EditorNavigationRequest[] = []
  const navigation = {
    open: async (request: EditorNavigationRequest) => {
      requests.push(request)
      return { status: "unknown" }
    },
    retireOwner: vi.fn()
  } as unknown as EditorNavigationBroker
  const context: NativePlatformCallContext = {
    workspace,
    threadId: "thread",
    incarnation: "birth",
    generation: "native",
    caller: { provider: "author", name: "author", digest: "digest", generation: "source" },
    signal: new AbortController().signal,
    assertCurrent() {
      /* This test's fixed scope remains current. */
    },
    publish() {
      /* Navigation publishes no guest state. */
    },
    invoke: async () => ({ requestKey: "none", status: "unknown" })
  }
  return {
    workspace,
    runtimeQuery,
    requests,
    context,
    provider: createDesktopEditorPlatformProvider(manager, navigation, () => "birth")
  }
}
it.each(["ask", "deny"])("does not bypass original %s file permission", async (decision) => {
  const f = await fixture()
  mocks.probe.mockResolvedValue({ decision })
  await expect(f.provider.act(f.context, "preview", { path: "source.ts" })).rejects.toThrow(
    "PATH_DENIED"
  )
  expect(f.requests).toHaveLength(0)
  expect(mocks.open).not.toHaveBeenCalled()
})
it("also enforces the bound native runtime's original policy", async () => {
  const f = await fixture()
  f.runtimeQuery.mockResolvedValue({ decision: "deny" })
  await expect(f.provider.act(f.context, "preview", { path: "source.ts" })).rejects.toThrow(
    "PATH_DENIED"
  )
  expect(f.requests).toHaveLength(0)
})
it("launches no IDE during preview; the later native intent uses only saved host configuration", async () => {
  const f = await fixture()
  await f.provider.act(f.context, "preview", { path: "source.ts", line: 1 })
  expect(mocks.open).not.toHaveBeenCalled()
  await expect(f.requests[0].launchExternal!()).resolves.toEqual({ mode: "workspace+file+line" })
  expect(mocks.open).toHaveBeenCalledWith({
    ide: "vscode",
    workspacePath: f.workspace,
    filePath: join(f.workspace, "source.ts"),
    line: 1
  })
  mocks.preference = null
  await expect(f.requests[0].launchExternal!()).resolves.toEqual({
    unavailable: true,
    reason: "ide-not-configured"
  })
  expect(mocks.open).toHaveBeenCalledTimes(1)
})
it
  .runIf(process.platform === "win32")
  .each(["source&not-a-command.ts", "source --disable-extensions args.ts"])(
  "never passes a guest filename %s into Windows shell argument parsing",
  async (file) => {
    const f = await fixture()
    await writeFile(join(f.workspace, file), "const safe = true")
    await f.provider.act(f.context, "preview", { path: file })
    await expect(f.requests[0].launchExternal!()).resolves.toEqual({
      unavailable: true,
      reason: "path-requires-built-in-preview"
    })
    expect(mocks.open).not.toHaveBeenCalled()
  }
)
it.runIf(process.platform === "win32")(
  "keeps whitespace workspaces in built-in source preview",
  async () => {
    const f = await fixture(true)
    await f.provider.act(f.context, "preview", { path: "source.ts" })
    await expect(f.requests[0].launchExternal!()).resolves.toEqual({
      unavailable: true,
      reason: "path-requires-built-in-preview"
    })
    expect(mocks.open).not.toHaveBeenCalled()
  }
)
