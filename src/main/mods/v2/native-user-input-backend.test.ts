import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { LocalSandbox } from "../../agent/local-sandbox"
import * as adapters from "../adapters"
import { ModPermissionError } from "../errors"
import { HookHaltError } from "../../hooks/halt"
import { modCallContext } from "../context"
import { modToolHasNotStarted } from "../execution-error"

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mods-user-input-"))
  roots.push(root)
  const attached = vi.spyOn(adapters, "attachModBackend").mockReturnValue(() => {})
  const native = vi.fn(async () => "native answer")
  const backend = new LocalSandbox({
    rootDir: root,
    runId: "thread",
    windowsSandbox: "none",
    modUserInput: native
  })
  const invoke = attached.mock.calls.at(-1)![3]!.userInput!
  return { backend, invoke, native }
}
it("classic denial stops SDK questions before any native user interaction", async () => {
  const f = await fixture()
  vi.spyOn(f.backend, "runPreToolUseHookForTool").mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: true,
    reason: "classic denied"
  })
  await expect(f.invoke({ questions: [] }, new AbortController().signal)).rejects.toThrow(
    "classic denied"
  )
  expect(f.native).not.toHaveBeenCalled()
})
it("reuses final classic input, post output and cancellation checks", async () => {
  const f = await fixture()
  const effective = { questions: [] }
  const pre = vi.spyOn(f.backend, "runPreToolUseHookForTool").mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: false,
    updatedInput: effective
  })
  const post = vi
    .spyOn(f.backend, "applyPostToolUseHookToText")
    .mockResolvedValue("published answer")
  expect(await f.invoke({ questions: [{}] }, new AbortController().signal)).toBe("published answer")
  expect(f.native).toHaveBeenCalledWith(effective, expect.any(AbortSignal))
  expect(post).toHaveBeenCalledWith("request_user_input", effective, "native answer")
  const controller = new AbortController()
  pre.mockImplementation(async () => {
    controller.abort()
    return null
  })
  await expect(f.invoke(effective, controller.signal)).rejects.toThrow()
  expect(f.native).toHaveBeenCalledTimes(1)
  expect(post).toHaveBeenCalledTimes(1)
})

it("marks native classic denial as not started and preserves its published reason", async () => {
  const f = await fixture()
  vi.spyOn(f.backend, "runPreToolUseHookForTool").mockRejectedValue(
    new HookHaltError({
      hookEvent: "PreToolUse",
      fallbackReason: "private reason"
    })
  )
  const publish = vi
    .spyOn(adapters, "publishCurrentModResult")
    .mockResolvedValue("published denial")
  const context = {
    identity: { callId: "ask-call" },
    toolId: "host:request_user_input",
    routeClaimed: true,
    protectedOutput: true,
    readOnly: false
  } as Parameters<typeof modCallContext.run>[0]
  const failure = await modCallContext.run(context, () =>
    f.invoke({ questions: [] }, new AbortController().signal).catch((error: unknown) => error)
  )
  expect(failure).toBeInstanceOf(ModPermissionError)
  expect((failure as Error).message).toContain("published denial")
  expect(modToolHasNotStarted(failure, "ask-call")).toBe(true)
  expect(publish).toHaveBeenCalledWith("private reason")
  expect(f.native).not.toHaveBeenCalled()
})
