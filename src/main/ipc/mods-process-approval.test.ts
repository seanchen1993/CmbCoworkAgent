import type { MessageBoxOptions } from "electron"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { confirmFunctionProcess } from "./mods-process-approval"
import type { FunctionProcessRequest } from "../mods/v2/process-sdk"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "process-approval-test-"))
  roots.push(root)
  const controller = new AbortController()
  const request: Readonly<FunctionProcessRequest> = Object.freeze({
    argv: Object.freeze(["python", "-c", "print('中文\\n')"]),
    cwd: root,
    env: Object.freeze({ PRIVATE_VALUE: "do-not-log-this" }),
    input: "完整输入\n😀",
    timeoutMs: 30_000
  })
  const host = {
    tempRoot: root,
    signal: controller.signal,
    assertCurrent: vi.fn(),
    showDialog: vi
      .fn<(options: MessageBoxOptions) => Promise<{ response: number }>>()
      .mockResolvedValue({ response: 1 }),
    openPath: vi.fn<(path: string) => Promise<string>>().mockResolvedValue("")
  }
  return { root, request, host, controller }
}

it("bounds the native dialog while preserving a large complete request and its hashes", async () => {
  const f = await setup()
  const request = Object.freeze({
    ...f.request,
    argv: Object.freeze(["python", "-c", "x".repeat(60_000)]),
    env: Object.freeze({ PRIVATE_VALUE: "secret".repeat(5_000) }),
    input: "中文😀\n".repeat(40_000)
  })
  const before = JSON.stringify(request)
  let full = ""
  f.host.showDialog.mockResolvedValueOnce({ response: 2 }).mockResolvedValueOnce({ response: 1 })
  f.host.openPath.mockImplementation(async (path) => {
    full = await readFile(path, "utf8")
    expect(JSON.parse(full)).toEqual(request)
    expect(path.endsWith("request.json")).toBe(true)
    return ""
  })
  await confirmFunctionProcess("plugin\n\u2028\u2029".repeat(1_000), request, f.host)
  for (const [options] of f.host.showDialog.mock.calls) {
    expect(options.detail!.length).toBeLessThan(1_400)
    expect(options.message.length).toBeLessThan(250)
    expect(options.message).not.toMatch(/[\u0085\u2028\u2029]/u)
    expect(options.detail!.split("\n")).toHaveLength(10)
    expect(options.detail).toContain(String(Buffer.byteLength(request.input)))
    expect(options.detail).toContain(createHash("sha256").update(full).digest("hex"))
    expect(options.detail).toContain(createHash("sha256").update(request.input).digest("hex"))
    expect(options.detail).not.toContain("secret")
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
    expect(options.buttons).toEqual(["拒绝", "允许本次命令", "查看完整请求"])
    expect(options.signal).toBe(f.controller.signal)
  }
  expect(JSON.stringify(request)).toBe(before)
  expect(f.host.openPath).toHaveBeenCalledTimes(1)
  expect(await readdir(f.root)).toEqual([])
})

it.each([0, -1, 3])("rejects response %s and removes the snapshot", async (response) => {
  const f = await setup()
  f.host.showDialog.mockResolvedValue({ response })
  await expect(confirmFunctionProcess("plugin", f.request, f.host)).rejects.toThrow(
    "MODS_PROCESS_DENIED"
  )
  expect(f.host.openPath).not.toHaveBeenCalled()
  expect(await readdir(f.root)).toEqual([])
})

it("reuses one unchanged snapshot for repeated viewing, without approving", async () => {
  const f = await setup()
  f.host.showDialog
    .mockResolvedValueOnce({ response: 2 })
    .mockResolvedValueOnce({ response: 2 })
    .mockResolvedValueOnce({ response: 0 })
  await expect(confirmFunctionProcess("plugin", f.request, f.host)).rejects.toThrow(
    "MODS_PROCESS_DENIED"
  )
  expect(f.host.openPath.mock.calls[0][0]).toBe(f.host.openPath.mock.calls[1][0])
  expect(await readdir(f.root)).toEqual([])
})

it.each(["cancel", "grant", "owner", "resource"])(
  "does not accept a late allow after %s changes during viewing",
  async (change) => {
    const f = await setup()
    f.host.showDialog.mockResolvedValueOnce({ response: 2 }).mockResolvedValueOnce({ response: 1 })
    f.host.openPath.mockImplementation(async () => {
      if (change === "cancel") f.controller.abort(Error("cancelled"))
      else
        f.host.assertCurrent.mockImplementation(() => {
          throw Error(change + " changed")
        })
      return ""
    })
    await expect(confirmFunctionProcess("plugin", f.request, f.host)).rejects.toThrow(
      change === "cancel" ? "cancelled" : change + " changed"
    )
    expect(f.host.showDialog).toHaveBeenCalledTimes(1)
    expect(await readdir(f.root)).toEqual([])
  }
)

it("rejects cancellation while the confirmation itself is pending", async () => {
  const f = await setup()
  f.host.showDialog.mockImplementation(async () => {
    f.controller.abort(Error("cancelled"))
    return { response: 1 }
  })
  await expect(confirmFunctionProcess("plugin", f.request, f.host)).rejects.toThrow("cancelled")
  expect(await readdir(f.root)).toEqual([])
})

it.each(["modify", "remove"])("rejects a %s snapshot before re-confirming", async (change) => {
  const f = await setup()
  f.host.showDialog.mockResolvedValueOnce({ response: 2 }).mockResolvedValueOnce({ response: 1 })
  f.host.openPath.mockImplementation(async (path) => {
    await chmod(path, 0o600)
    if (change === "remove") await unlink(path)
    else await writeFile(path, "{}")
    return ""
  })
  await expect(confirmFunctionProcess("plugin", f.request, f.host)).rejects.toThrow(
    "MODS_PROCESS_REVIEW_CHANGED"
  )
  expect(f.host.showDialog).toHaveBeenCalledTimes(1)
  expect(await readdir(f.root)).toEqual([])
})

it.each(["result", "throw"])(
  "fails closed without leaking viewer error details (%s)",
  async (kind) => {
    const f = await setup()
    f.host.showDialog.mockResolvedValue({ response: 2 })
    f.host.openPath.mockImplementation(async () => {
      if (kind === "throw") throw Error("sensitive-system-error")
      return "sensitive-system-error"
    })
    await expect(confirmFunctionProcess("plugin", f.request, f.host)).rejects.toThrow(
      /^MODS_PROCESS_REVIEW_UNAVAILABLE$/
    )
    expect(f.host.showDialog).toHaveBeenCalledTimes(1)
    expect(await readdir(f.root)).toEqual([])
  }
)

it("rechecks the full request after a final allow response", async () => {
  const f = await setup()
  let snapshot = ""
  f.host.openPath.mockImplementation(async (path) => {
    snapshot = path
    return ""
  })
  f.host.showDialog.mockResolvedValueOnce({ response: 2 }).mockImplementationOnce(async () => {
    await chmod(snapshot, 0o600)
    await writeFile(snapshot, "{}")
    return { response: 1 }
  })
  await expect(confirmFunctionProcess("plugin", f.request, f.host)).rejects.toThrow(
    "MODS_PROCESS_REVIEW_CHANGED"
  )
  expect(await readdir(f.root)).toEqual([])
})

it.each([0, 1])(
  "fails closed on cleanup failure, preserving an earlier denial (%s)",
  async (response) => {
    const f = await setup()
    f.host.showDialog.mockResolvedValueOnce({ response: 2 }).mockResolvedValueOnce({ response })
    f.host.openPath.mockImplementation(async (path) => {
      await writeFile(join(dirname(path), "viewer-created-file"), "")
      return ""
    })
    await expect(confirmFunctionProcess("plugin", f.request, f.host)).rejects.toThrow(
      response === 0 ? "MODS_PROCESS_DENIED" : "MODS_PROCESS_REVIEW_CLEANUP_FAILED"
    )
    const [directory] = await readdir(f.root)
    expect(await readdir(join(f.root, directory))).toEqual(["viewer-created-file"])
  }
)

it("fails closed if the private snapshot cannot be created", async () => {
  const f = await setup()
  f.host.tempRoot = join(f.root, "missing")
  await expect(confirmFunctionProcess("plugin", f.request, f.host)).rejects.toThrow(
    "MODS_PROCESS_REVIEW_UNAVAILABLE"
  )
  expect(f.host.showDialog).not.toHaveBeenCalled()
})

it("keeps simultaneous requests isolated and cleans both", async () => {
  const f = await setup()
  const other = { ...f.request, input: "other input" }
  const paths: string[] = []
  const makeHost = (request: Readonly<FunctionProcessRequest>) => ({
    ...f.host,
    showDialog: vi
      .fn()
      .mockResolvedValueOnce({ response: 2 })
      .mockResolvedValueOnce({ response: 1 }),
    openPath: async (path: string) => {
      paths.push(path)
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(request)
      return ""
    }
  })
  await Promise.all([
    confirmFunctionProcess("one", f.request, makeHost(f.request)),
    confirmFunctionProcess("two", other, makeHost(other))
  ])
  expect(new Set(paths).size).toBe(2)
  expect(await readdir(f.root)).toEqual([])
})
