import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { DEVELOPER_CODE_METHODS } from "../../../shared/mods/v2/developer-code-capability"
import type { ModObject } from "../../../shared/mods/types"
import type { NativePlatformCallContext } from "./platform-capabilities-types"

const lookup = vi.hoisted(() => vi.fn())
vi.mock("../../lsp", () => ({ getRunningClientForWorkspace: lookup }))
import { createNativeCodePlatformProvider } from "./platform-code-native"

const roots: string[] = []
afterEach(async () => {
  lookup.mockReset()
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-code-native-")
    )
      throw Error("OWNED_TEST_DIRECTORY_REQUIRED")
    await rm(root, { recursive: true, force: true })
  }
})

it("uses all original methods, authorized text and the same client identity across adapters", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-code-native-"))
  roots.push(root)
  const path = join(root, "Main.java")
  const text = "class Main {}\n"
  await writeFile(path, text)
  let version = 0
  const native = {
    isReady: () => true,
    getStartupStatus: () => ({
      serviceReady: true,
      projectReady: false,
      languageStatusMessage: "private native message must not leak"
    }),
    getObservedDocumentVersion: () => version || null,
    getObservedDocumentGeneration: () => version,
    openFile: vi.fn(async () => {
      version++
    }),
    definition: vi.fn(async () => []),
    references: vi.fn(async () => []),
    hover: vi.fn(async () => ({ contents: "native hover" })),
    implementation: vi.fn(async () => []),
    documentSymbols: vi.fn(async () => []),
    workspaceSymbol: vi.fn(async () => []),
    getDiagnostics: vi.fn(() => []),
    prepareCallHierarchy: vi.fn(async () => []),
    incomingCalls: vi.fn(async () => []),
    outgoingCalls: vi.fn(async () => [])
  }
  lookup.mockReturnValue(native)
  const context: NativePlatformCallContext = {
    workspace: root,
    threadId: "t",
    incarnation: "birth",
    generation: "g",
    caller: { provider: "p", digest: "d", generation: "pg", name: "p" },
    signal: new AbortController().signal,
    assertCurrent() {
      this.signal.throwIfAborted()
    },
    publish() {
      throw Error("NO_BACKGROUND_PUBLICATION")
    },
    async invoke() {
      throw Error("NO_NESTED_EFFECT")
    }
  }
  const provider = createNativeCodePlatformProvider({ authorizePath: async () => {} })
  const other = createNativeCodePlatformProvider({ authorizePath: async () => {} })
  const before = (await provider.read!(context)) as ModObject
  expect(((await other.read!(context)) as ModObject).instanceId).toBe(before.instanceId)
  expect(JSON.stringify(before)).not.toContain("private native")
  expect(native.openFile).not.toHaveBeenCalled()
  for (const method of DEVELOPER_CODE_METHODS) {
    const input: ModObject =
      method === "workspaceSymbol"
        ? { query: "Main" }
        : method === "diagnostics" || method === "documentSymbols"
          ? { path: "Main.java" }
          : { path: "Main.java", line: 2, column: 3 }
    await provider.act(context, method, input)
    const target = method === "diagnostics" ? native.getDiagnostics : native[method]
    expect(target).toHaveBeenCalledOnce()
    if (method === "workspaceSymbol") expect(target).toHaveBeenCalledWith("Main")
    else if (method === "documentSymbols" || method === "diagnostics")
      expect(target).toHaveBeenCalledWith(path)
    else expect(target).toHaveBeenCalledWith(path, 2, 3)
  }
  expect(native.openFile).toHaveBeenCalledTimes(8)
  expect(native.openFile).toHaveBeenLastCalledWith(path, text)
  await provider.close?.()
  await other.close?.()
})
