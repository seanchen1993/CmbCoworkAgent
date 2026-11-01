import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import { DEVELOPER_CODE_METHODS } from "../../../shared/mods/v2/developer-code-capability"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { FunctionPlugin } from "./dispatcher"
import {
  createCodePlatformProvider,
  type CodeObservationClient,
  type CodePlatformDependencies
} from "./platform-code-provider"

const roots: string[] = []
const providers: ReturnType<typeof createCodePlatformProvider>[] = []
const location = (file: string) => ({ file, line: 1, column: 1, endLine: 1, endColumn: 4 })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "mods-code-provider-"))
  roots.push(parent)
  const root = join(parent, "workspace")
  await mkdir(root)
  const path = join(root, "Main.java")
  await writeFile(path, 'class Main { String text = "你好"; }\n')
  const versions = new Map<string, number>()
  const query = vi.fn<CodeObservationClient["query"]>(async (method, request) => {
    if (method === "hover") return { contents: "Java Main" }
    if (method === "incomingCalls")
      return [
        {
          from: { ...location(path), name: "caller" },
          fromRanges: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 3 }]
        }
      ]
    if (method === "outgoingCalls")
      return [{ to: { ...location(path), name: "callee" }, fromRanges: [] }]
    return [
      {
        ...location(request.filePath ?? path),
        name: "Main",
        kind: "class",
        message: "cached diagnostic"
      }
    ]
  })
  const openFile = vi.fn(async (file: string, text: string) => {
    expect(text).toBe(await readFile(file, "utf8"))
    versions.set(file, (versions.get(file) ?? 0) + 1)
  })
  const client: CodeObservationClient = {
    identity: "actual-java-client-1",
    status: () => ({ initialized: true, serviceReady: true, projectReady: true }),
    documentVersion: (file) => versions.get(file) ?? null,
    documentGeneration: () => [...versions.values()].reduce((total, version) => total + version, 0),
    openFile,
    query
  }
  let current: CodeObservationClient | undefined = client
  let revoked = false
  const controller = new AbortController()
  const context: NativePlatformCallContext = {
    workspace: root,
    threadId: "thread",
    incarnation: "birth",
    generation: "generation",
    caller: {
      name: "plugin",
      provider: "plugin",
      digest: "source-digest",
      generation: "source-generation"
    },
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted()
      if (revoked) throw Error("SOURCE_REVOKED")
    },
    publish() {
      throw Error("NO_BACKGROUND_PUBLICATION")
    },
    async invoke() {
      throw Error("NO_NESTED_EFFECTS")
    }
  }
  const authorizePath = vi.fn<CodePlatformDependencies["authorizePath"]>(async () => {})
  const capture = vi.fn(() => current)
  const deps = { capture, authorizePath, waitMs: 1000 }
  const provider = createCodePlatformProvider(deps)
  providers.push(provider)
  const act = (method: string, input: ModObject, owner = context) =>
    provider.act(owner, method, input)
  return {
    root,
    parent,
    path,
    client,
    query,
    openFile,
    context,
    controller,
    authorizePath,
    capture,
    provider,
    deps,
    versions,
    act,
    revoke: () => {
      revoked = true
    },
    replace: (next?: CodeObservationClient) => {
      current = next
    }
  }
}
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close?.()
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-code-provider-")
    )
      throw Error("OWNED_TEST_DIRECTORY_REQUIRED")
    await rm(root, { recursive: true, force: true })
  }
})

describe("native Java code capability", () => {
  it("discovers actual running Java support without opening a file or starting a service", async () => {
    const f = await fixture()
    const status = (await f.provider.read!(f.context)) as ModObject
    expect(status).toMatchObject({
      language: "java",
      status: "running",
      diagnostics: "cached/versionUnknown",
      inFlight: 0
    })
    expect(f.openFile).not.toHaveBeenCalled()
    expect(f.authorizePath).not.toHaveBeenCalled()
    expect(f.provider.descriptor.actions.map((action) => action.id)).toEqual([
      ...DEVELOPER_CODE_METHODS
    ])
    f.replace(undefined)
    expect(await f.provider.read!(f.context)).toMatchObject({
      status: "unavailable",
      reason: "service-not-running"
    })
    await expect(f.act("hover", { path: "Main.java", line: 1, column: 1 })).rejects.toThrow(
      "UNAVAILABLE"
    )
    expect(f.query).not.toHaveBeenCalled()
  })

  it.each(DEVELOPER_CODE_METHODS)(
    "routes %s to the same original client with bounded observations",
    async (method) => {
      const f = await fixture()
      const args: ModObject =
        method === "workspaceSymbol"
          ? { query: "Main" }
          : method === "diagnostics"
            ? { path: "Main.java" }
            : method === "documentSymbols"
              ? { path: "Main.java" }
              : { path: "Main.java", line: 1, column: 1 }
      const result = (await f.act(method, args)) as ModObject
      expect(result).toMatchObject({
        language: "java",
        instanceId: f.client.identity,
        coordinates: "1-based-line-and-UTF16-column"
      })
      expect(f.query).toHaveBeenCalledOnce()
      expect(f.query.mock.calls[0][0]).toBe(method)
      if (method === "diagnostics") {
        expect(result).toMatchObject({
          diagnostics: "cached",
          versionUnknown: true,
          documentVersion: null
        })
        expect(f.openFile).not.toHaveBeenCalled()
      } else if (method !== "workspaceSymbol") {
        expect(f.openFile).toHaveBeenCalledOnce()
        expect(result.documentVersion).toBe(1)
        expect(f.authorizePath).toHaveBeenCalled()
      }
      if ("items" in result) expect(JSON.stringify(result)).toContain("Main.java")
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16_000)
    }
  )

  it.each<ModObject>([
    { path: "../Outside.java", line: 1, column: 1 },
    { path: "C:/Outside.java", line: 1, column: 1 },
    { path: "Main.java", line: 0, column: 1 },
    { path: "Main.java", line: 1, column: 1, command: "anything" },
    { path: "README.md", line: 1, column: 1 },
    { path: ".git/Main.java", line: 1, column: 1 }
  ])("rejects invalid or non-Java input before any native query: %j", async (args) => {
    const f = await fixture()
    await expect(f.act("definition", args)).rejects.toThrow("MODS_CODE_")
    expect(f.query).not.toHaveBeenCalled()
  })

  it("rejects empty workspace queries and permission denial before reading or opening", async () => {
    const f = await fixture()
    await expect(f.act("workspaceSymbol", { query: "  " })).rejects.toThrow("QUERY")
    f.authorizePath.mockRejectedValue(Error("NATIVE_READ_DENIED"))
    await expect(f.act("definition", { path: "Main.java", line: 1, column: 1 })).rejects.toThrow(
      "NATIVE_READ_DENIED"
    )
    expect(f.openFile).not.toHaveBeenCalled()
    expect(f.query).not.toHaveBeenCalled()
  })

  it("checks current authority again after the original permission probe", async () => {
    const f = await fixture()
    f.authorizePath.mockImplementationOnce(async () => {
      f.revoke()
    })
    await expect(f.act("hover", { path: "Main.java", line: 1, column: 1 })).rejects.toThrow(
      "SOURCE_REVOKED"
    )
    expect(f.openFile).not.toHaveBeenCalled()
  })

  it("rejects hardlinks and malformed UTF8 before sending text to Java", async () => {
    const f = await fixture()
    await writeFile(f.path, Buffer.from([0xff, 0xfe]))
    await expect(f.act("hover", { path: "Main.java", line: 1, column: 1 })).rejects.toThrow()
    await writeFile(f.path, "class Main {}")
    await link(f.path, join(f.parent, "hardlink.java"))
    await expect(f.act("hover", { path: "Main.java", line: 1, column: 1 })).rejects.toThrow(
      "FILE_LINK"
    )
    expect(f.openFile).not.toHaveBeenCalled()
  })

  it("rejects oversized/binary content and links escaping the workspace", async () => {
    const f = await fixture()
    await writeFile(f.path, "x".repeat(512 * 1024 + 1))
    await expect(f.act("hover", { path: "Main.java", line: 1, column: 1 })).rejects.toThrow("large")
    await writeFile(f.path, "class Main {}\0")
    await expect(f.act("hover", { path: "Main.java", line: 1, column: 1 })).rejects.toThrow(
      "BINARY"
    )
    const outside = join(f.parent, "Outside.java")
    await writeFile(outside, "class Outside {}")
    await symlink(
      f.parent,
      join(f.root, "escape"),
      process.platform === "win32" ? "junction" : "dir"
    )
    await expect(
      f.act("hover", { path: "escape/Outside.java", line: 1, column: 1 })
    ).rejects.toThrow("OUTSIDE_WORKSPACE")
    expect(f.openFile).not.toHaveBeenCalled()
  })

  it("drops out-of-root and denied result locations, with UTF8 byte bounded output", async () => {
    const f = await fixture()
    const outside = join(f.parent, "Outside.java")
    await writeFile(outside, "class Outside {}")
    f.query.mockResolvedValue([
      location(outside),
      ...Array.from({ length: 80 }, () => location(f.path))
    ])
    const result = (await f.act("references", {
      path: "Main.java",
      line: 1,
      column: 1,
      limit: 2
    })) as ModObject
    expect(result).toMatchObject({ filtered: true, truncated: true })
    expect((result.items as unknown[]).length).toBe(2)
    expect(JSON.stringify(result)).not.toContain(outside)
    f.query.mockResolvedValue({ contents: "中文😀".repeat(8000) })
    const hover = await f.act("hover", { path: "Main.java", line: 1, column: 1 })
    expect(hover).toMatchObject({ truncated: true })
    expect(Buffer.byteLength(JSON.stringify(hover))).toBeLessThan(16_000)
  })

  it.each(["disk", "document", "restart", "revoke"])(
    "rejects a late result after %s changes",
    async (change) => {
      const f = await fixture()
      const pending = deferred<unknown>()
      f.query.mockReturnValue(pending.promise)
      const request = f.act("definition", { path: "Main.java", line: 1, column: 1 })
      const rejected = expect(request).rejects.toThrow()
      await vi.waitFor(() => expect(f.query).toHaveBeenCalledOnce())
      if (change === "disk") await writeFile(f.path, "class Changed {}")
      if (change === "document") f.versions.set(f.path, 999)
      if (change === "restart") f.replace({ ...f.client, identity: "new-java-client" })
      if (change === "revoke") f.revoke()
      pending.resolve([location(f.path)])
      await rejected
    }
  )

  it("retains shared native admission after timeout, cancellation and reload until actual settlement", async () => {
    const f = await fixture()
    const pending = deferred<unknown>()
    f.query.mockReturnValue(pending.promise)
    const provider = createCodePlatformProvider({ ...f.deps, waitMs: 20 })
    providers.push(provider)
    await expect(
      provider.act(f.context, "hover", { path: "Main.java", line: 1, column: 1 })
    ).rejects.toThrow("WAIT_TIMEOUT_NATIVE_UNSETTLED")
    await provider.close?.()
    const replacement = createCodePlatformProvider(f.deps)
    providers.push(replacement)
    await expect(
      replacement.act(f.context, "hover", { path: "Main.java", line: 1, column: 1 })
    ).rejects.toThrow("BUSY_UNSETTLED")
    pending.resolve({ contents: "late and unpublished" })
    await vi.waitFor(async () => {
      f.query.mockResolvedValue({ contents: "fresh" })
      expect(
        await replacement.act(f.context, "hover", { path: "Main.java", line: 1, column: 1 })
      ).toMatchObject({ hover: { contents: "fresh" } })
    })
    const cancel = deferred<unknown>()
    f.query.mockReturnValue(cancel.promise)
    const request = replacement.act(f.context, "hover", { path: "Main.java", line: 1, column: 1 })
    const rejected = expect(request).rejects.toThrow("WAIT_ABORTED_NATIVE_UNSETTLED")
    await vi.waitFor(() => expect(f.query.mock.calls.length).toBeGreaterThan(2))
    f.controller.abort()
    await rejected
    cancel.resolve({ contents: "cancelled wait late reply" })
  })

  it("binds receipt access to caller, file bytes and client identity without a sync file read", async () => {
    const f = await fixture()
    const args = { path: "Main.java", line: 1, column: 1 }
    const first = await f.provider.prepareActionAccess!(f.context, "definition", args)
    const stable = await f.provider.prepareActionAccess!(f.context, "definition", args)
    expect(stable!.identity).toBe(first!.identity)
    await writeFile(f.path, "class Different {}")
    const changed = await f.provider.prepareActionAccess!(f.context, "definition", args)
    expect(changed!.identity).not.toBe(first!.identity)
    f.replace({ ...f.client, identity: "new-instance" })
    expect(() => changed!.assertCurrent()).toThrow("CLIENT_CHANGED")
    expect(f.query).not.toHaveBeenCalled()
  })

  it("rejects a saved result when only its other-file location loses native permission", async () => {
    const f = await fixture()
    const other = join(f.root, "Other.java")
    await writeFile(other, "class Other {}")
    const args = { path: "Main.java", line: 1, column: 1 }
    f.query.mockResolvedValue([location(other)])
    const access = await f.provider.prepareActionAccess!(f.context, "definition", args)
    const saved = await f.act("definition", args)
    await f.provider.validateActionResultAccess!(f.context, "definition", args, saved)
    f.authorizePath.mockImplementation(async (context, path) => {
      context.assertCurrent()
      if (path === other) throw Error("OTHER_FILE_READ_REVOKED")
    })
    const current = await f.provider.prepareActionAccess!(f.context, "definition", args)
    expect(current!.identity).toBe(access!.identity)
    await expect(
      f.provider.validateActionResultAccess!(f.context, "definition", args, saved)
    ).rejects.toThrow("OTHER_FILE_READ_REVOKED")
    expect(f.query).toHaveBeenCalledOnce()
    expect(saved).toMatchObject({ items: [{ file: "Other.java" }] })
  })

  it("rechecks extra result paths through real core status and cached action receipts without replay", async () => {
    const f = await fixture()
    const other = join(f.root, "Other.java")
    await writeFile(other, "class Other {}")
    f.query.mockResolvedValue([location(other)])
    const caller: FunctionPlugin = {
      name: "code-consumer",
      root: f.root,
      tier: "user",
      capabilities: [...SESSION_CAPABILITIES],
      guest: await FunctionGuestRuntime.create("globalThis.__cmbFunctionMod={register(){}}")
    }
    const session = new FunctionSession([caller], {
      workspace: f.root,
      threadId: f.context.threadId,
      platformIncarnation: "birth",
      platformNativeProviders: [f.provider],
      assertLive: () => f.context.assertCurrent(),
      publish: async (value) => value
    })
    const ref = { provider: "native.code", id: "java", version: "1.0.0" }
    const target = { kind: "current" }
    const request = {
      ref,
      target,
      action: "definition",
      requestKey: "one-observation",
      input: { path: "Main.java", line: 1, column: 1 }
    }
    try {
      const first = await session.platform.act(caller, request, f.context.signal)
      expect(first).toMatchObject({
        status: "succeeded",
        value: { items: [{ file: "Other.java" }] }
      })
      f.authorizePath.mockImplementation(async (context, path) => {
        context.assertCurrent()
        if (path === other) throw Error("OTHER_FILE_READ_REVOKED")
      })
      await expect(
        session.platform.call(
          caller,
          "platform.status",
          [{ ref, target, requestKey: request.requestKey }],
          f.context.signal
        )
      ).rejects.toThrow("OTHER_FILE_READ_REVOKED")
      await expect(session.platform.act(caller, request, f.context.signal)).rejects.toThrow(
        "OTHER_FILE_READ_REVOKED"
      )
      expect(f.query).toHaveBeenCalledOnce()
      expect(first).toMatchObject({
        status: "succeeded",
        value: { items: [{ file: "Other.java" }] }
      })
    } finally {
      await session.close(true)
    }
  })
})
