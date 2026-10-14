import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { ModError } from "../errors"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"

type DirectoryMode = "data" | "legacy" | "legacy-denied" | "workspace"
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, "Directory fixture cleanup failed")
})

async function fixture(mode: DirectoryMode) {
  const root = await mkdtemp(join(tmpdir(), "mods-cwd-file-scope-"))
  const resources: { store?: ModControlStore; manager?: FunctionModsManager } = {}
  cleanups.push(async () => {
    const failures: unknown[] = []
    try {
      resources.manager?.close()
    } catch (error) {
      failures.push(error)
    }
    try {
      resources.store?.close()
    } catch (error) {
      failures.push(error)
    }
    try {
      if (
        dirname(resolve(root)) !== resolve(tmpdir()) ||
        !basename(root).startsWith("mods-cwd-file-scope-")
      )
        throw Error("Unexpected directory fixture cleanup path")
      await rm(root, { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) throw new AggregateError(failures, "Directory fixture resources failed")
  })
  const plugin = join(root, "plugin"),
    executionRoot = join(root, "execution")
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true })
  await mkdir(join(plugin, "hooks"))
  await mkdir(executionRoot)
  await writeFile(
    join(plugin, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "cwd-file-scope", version: "1.0.0" })
  )
  await writeFile(join(plugin, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
  await writeFile(
    join(plugin, "hooks/register.ts"),
    `export function register(on) {
    on("prompt.edit", async ($, e, next) => next(e));
    on("session.start", async ($, e, next) => {
      const result = await next(e);
      await $.store.set("startup", { input: e.cwd, output: result.cwd, read: await $.session.cwd() });
      await $.command.register({ name: "inspect-directory", description: "Read the directory" });
      await $.command.register({ name: "try-execution", description: "Observe permission rejection" });
      return result;
    });
    on("command.run", { command: "inspect-directory" }, async ($) =>
      ({ text: await $.session.cwd() }));
    on("command.run", { command: "try-execution" }, async ($) => {
      let file = "unexpected success", process = "unexpected success";
      try { await $.fs.read("probe.txt"); } catch (error) { file = error.message; }
      try { await $.process.run(["missing-cwd-fixture-program"]); }
      catch (error) { process = error.message; }
      return { text: JSON.stringify({ file, process }) };
    });
  }`
  )
  const store = new ModControlStore(join(root, "control.sqlite"))
  resources.store = store
  const threadId = "cold-coordinator"
  const cwd = vi.fn((workspace: string, id: string) => {
    expect(workspace).toBe(root)
    expect(id).toBe(threadId)
    return executionRoot
  })
  // The host boundary represents a cold thread with no file execution context.
  // It does not mint a coordinator runtime or simulate a native permission decision.
  const fileScope = vi.fn(() => {
    if (mode === "data" || mode === "legacy-denied")
      throw new ModError("MODS_THREAD_CONTEXT_REQUIRED")
    return {
      workspace: executionRoot,
      assertLive: () => undefined,
      queryTool: async () => ({ decision: "allow" as const })
    }
  })
  const authorizeProcess = vi.fn(async () => undefined)
  const runEffect = vi.fn<
    NonNullable<ConstructorParameters<typeof FunctionModsManager>[1]["runEffect"]>
  >((workspace, id, grant, method, input, signal, run) => {
    expect(workspace).toBe(root)
    expect(id).toBe(threadId)
    store.assertGrant(grant)
    expect(method).toBe("process.run")
    expect(input).toStrictEqual({ argv: ["missing-cwd-fixture-program"] })
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    return run()
  })
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [{ id: "source", name: "cwd-file-scope", path: plugin, enabled: true }],
      enabled: () => true,
      assertThread: (workspace, id) => {
        expect(workspace).toBe(root)
        expect(id).toBe(threadId)
      },
      ...(mode === "data" ? { cwd } : {}),
      ...(mode !== "workspace" ? { fileScope } : {}),
      authorizeProcess,
      runEffect,
      publish: async (_workspace, value) => value,
      changed: () => undefined
    },
    () => {
      const guests = new Set<FunctionGuestRuntime>()
      return {
        async load(code, options) {
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.add(guest)
          return guest
        },
        stop() {
          for (const guest of guests) guest.dispose()
        }
      }
    }
  )
  resources.manager = manager
  const [status] = await manager.status(root)
  if (!status?.digest) throw Error("Actual compiled directory plugin digest required")
  await manager.approve(root, "source", status.digest)
  const saved = () => store.functionState.get(JSON.stringify([root, "cwd-file-scope"]), "startup")
  const command = async (name: string) => {
    const descriptor = (await manager.commands(root, threadId)).find((row) => row.command === name)
    if (!descriptor) throw Error("Actual registered directory command required")
    return manager.runCommand(root, threadId, descriptor, "", new AbortController().signal)
  }
  return {
    root,
    executionRoot,
    threadId,
    manager,
    cwd,
    fileScope,
    authorizeProcess,
    runEffect,
    saved,
    command
  }
}

it("discovers a pure edit hook quietly and starts with the read-only execution directory", async () => {
  const f = await fixture("data")
  expect(await f.manager.hasEventHandler(f.root, f.threadId, "prompt.edit")).toBe(true)
  expect(f.saved()).toBeUndefined()
  expect(f.cwd).not.toHaveBeenCalled()
  expect(f.fileScope).not.toHaveBeenCalled()
  expect((await f.command("inspect-directory")).text).toBe(f.executionRoot)
  expect(f.saved()).toStrictEqual({
    input: f.executionRoot,
    output: f.executionRoot,
    read: f.executionRoot
  })
  expect(f.cwd).toHaveBeenCalled()
  expect(f.fileScope).not.toHaveBeenCalled()
  expect(f.authorizeProcess).not.toHaveBeenCalled()
})

it("still rejects real file and process requests at the original cold file-scope boundary", async () => {
  const f = await fixture("data")
  const result = await f.command("try-execution")
  expect(JSON.parse(String(result.text))).toStrictEqual({
    file: "MODS_THREAD_CONTEXT_REQUIRED",
    process: "MODS_THREAD_CONTEXT_REQUIRED"
  })
  expect(f.runEffect).toHaveBeenCalledOnce()
  expect(f.fileScope).toHaveBeenCalledTimes(2)
  expect(f.authorizeProcess).not.toHaveBeenCalled()
  expect(f.saved()).toStrictEqual({
    input: f.executionRoot,
    output: f.executionRoot,
    read: f.executionRoot
  })
})

it("keeps the old custom host's file-scope execution directory when no data callback exists", async () => {
  const f = await fixture("legacy")
  expect((await f.command("inspect-directory")).text).toBe(f.executionRoot)
  expect(f.saved()).toStrictEqual({
    input: f.executionRoot,
    output: f.executionRoot,
    read: f.executionRoot
  })
  expect(f.cwd).not.toHaveBeenCalled()
  expect(f.fileScope).toHaveBeenCalled()
})

it("preserves the old custom file-scope rejection instead of falling back to the workspace", async () => {
  const f = await fixture("legacy-denied")
  expect(await f.manager.hasEventHandler(f.root, f.threadId, "prompt.edit")).toBe(true)
  await expect(f.command("inspect-directory")).rejects.toThrow("MODS_THREAD_CONTEXT_REQUIRED")
  expect(f.saved()).toBeUndefined()
  expect(f.cwd).not.toHaveBeenCalled()
  expect(f.fileScope).toHaveBeenCalledOnce()
  expect(f.authorizeProcess).not.toHaveBeenCalled()
})

it("uses the workspace for an existing host that supplies neither directory nor file scope", async () => {
  const f = await fixture("workspace")
  expect((await f.command("inspect-directory")).text).toBe(f.root)
  expect(f.saved()).toStrictEqual({ input: f.root, output: f.root, read: f.root })
  expect(f.cwd).not.toHaveBeenCalled()
  expect(f.fileScope).not.toHaveBeenCalled()
})
