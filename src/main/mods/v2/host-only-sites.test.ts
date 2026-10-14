import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { UserInputRequest } from "../../types"
import { ModControlStore } from "../control-store"
import { FunctionHostOnlySites } from "./host-only-sites"
import { FunctionModsManager } from "./manager"
import { FunctionUiSites } from "./sites"

const close: Array<() => void> = []
afterEach(() => {
  for (const cleanup of close.splice(0)) cleanup()
})
const redact = (value: ModJson): ModJson =>
  JSON.parse(JSON.stringify(value).replaceAll("PRIVATE_BODY", "SAFE_BODY")) as ModJson

function fixture() {
  let incarnation = "one"
  let publish: (value: ModJson, signal: AbortSignal) => Promise<ModJson> = async (value) =>
    redact(value)
  let pending: Readonly<UserInputRequest> | null = null
  const publication = vi.fn((_workspace: string, value: ModJson, signal: AbortSignal) =>
    publish(value, signal)
  )
  const sites = new FunctionHostOnlySites({
    capture: () => {
      const actual = incarnation
      return () => {
        if (actual !== incarnation) throw new ModFunctionError("MODS_SCOPE_CHANGED")
      }
    },
    publish: publication,
    changed: vi.fn(),
    userMessageOrigin: (_thread, message) =>
      message === "actual-message" ? { kind: "plugin", name: "actual-source" } : undefined,
    pendingQuestion: () => pending
  })
  close.push(() => sites.close())
  return {
    sites,
    publication,
    rebind() {
      incarnation = "two"
    },
    setPublication(fn: typeof publish) {
      publish = fn
    },
    setQuestion(value: Readonly<UserInputRequest> | null) {
      pending = value
    }
  }
}

it("runs the real empty-plugin native core and protects both zero and the returned reference", async () => {
  const f = fixture()
  const owner = await f.sites.mount("/project", "thread", "AssistantMessage")
  const input = { text: "PRIVATE_BODY", isFirstOfReply: true }
  const frame = await f.sites.render("/project", "thread", owner, input)
  expect(frame.tree).toEqual({ type: "engine", ref: 1 })
  expect(frame.nativeContent?.component).toBe("AssistantMessage")
  expect(frame.nativeContent?.entries.map((entry) => [entry.ref, entry.props.text])).toEqual([
    [0, "SAFE_BODY"],
    [1, "SAFE_BODY"]
  ])
  expect(frame.nativeContent?.nativeUnchanged).toBe(false)
  expect(JSON.stringify(frame)).not.toContain("PRIVATE_BODY")
  expect(input.text).toBe("PRIVATE_BODY")
  expect(f.publication).toHaveBeenCalled()
})

it("gets a protected user message source only from the mounted durable ID", async () => {
  const f = fixture()
  const owner = await f.sites.mount("/project", "thread", "UserMessage", "actual-message")
  const frame = await f.sites.render("/project", "thread", owner, {
    text: "PRIVATE_BODY",
    isExpanded: false,
    origin: { kind: "plugin", name: "forged" }
  })
  expect(frame.nativeContent?.entries.map((entry) => entry.props.origin)).toEqual([
    { kind: "plugin", name: "actual-source" },
    { kind: "plugin", name: "actual-source" }
  ])
})

it("protects actual tool group bodies while keeping real IDs, order and status", async () => {
  const f = fixture()
  const owner = await f.sites.mount("/project", "thread", "ToolGroup")
  const call = {
    tool_use_id: "actual-call",
    tool: "execute",
    input: { command: "PRIVATE_BODY" },
    output: "PRIVATE_BODY",
    isRunning: false,
    isErrored: false,
    isInterrupted: false
  }
  const frame = await f.sites.render("/project", "thread", owner, {
    calls: [call],
    isActive: false,
    isExpanded: true
  })
  for (const entry of frame.nativeContent!.entries)
    expect(entry.props.calls).toEqual([
      { ...call, input: { command: "SAFE_BODY" }, output: "SAFE_BODY" }
    ])
  expect(call.input.command).toBe("PRIVATE_BODY")
})

it("rejects identity-changing publication rather than giving an unprotected frame", async () => {
  const f = fixture()
  f.setPublication(async (value) =>
    Array.isArray(value) && isModObject(value[0]) && "ref" in value[0]
      ? (value.map((row) => ({ ...(row as object), ref: 999 })) as ModJson)
      : value
  )
  const owner = await f.sites.mount("/project", "thread", "AssistantMessage")
  await expect(
    f.sites.render("/project", "thread", owner, { text: "PRIVATE_BODY", isFirstOfReply: true })
  ).rejects.toMatchObject({ code: "MODS_UI_NATIVE_PUBLICATION" })
})

it.each(["invalidate", "close-thread", "incarnation"])(
  "rejects a held actual publication after %s and never adopts the late answer",
  async (reason) => {
    const f = fixture()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    f.setPublication(async (value) => {
      enter()
      await barrier
      return redact(value)
    })
    const owner = await f.sites.mount("/project", "thread", "AssistantMessage")
    const actual = f.sites.render("/project", "thread", owner, {
      text: "PRIVATE_BODY",
      isFirstOfReply: true
    })
    const result = expect(actual).rejects.toMatchObject({ code: "MODS_SCOPE_CHANGED" })
    await entered
    if (reason === "invalidate") f.sites.invalidate("/project")
    else if (reason === "close-thread") f.sites.closeThread("thread")
    else f.rebind()
    release()
    await result
  }
)

it("does not route one private slot to another thread, workspace or guessed callback", async () => {
  const f = fixture()
  const owner = await f.sites.mount("/project", "thread", "AssistantMessage")
  for (const [workspace, thread] of [
    ["/elsewhere", "thread"],
    ["/project", "other"]
  ])
    await expect(
      f.sites.render(workspace, thread, owner, { text: "PRIVATE_BODY", isFirstOfReply: true })
    ).rejects.toMatchObject({ code: "MODS_UI_SITE_CLOSED" })
  const frame = await f.sites.render("/project", "thread", owner, {
    text: "PRIVATE_BODY",
    isFirstOfReply: true
  })
  await expect(
    f.sites.act("/project", "thread", owner, {
      pane: frame.key,
      generation: frame.generation,
      plugin: "engine",
      intentId: randomUUID(),
      kind: "press",
      handle: 0
    })
  ).rejects.toMatchObject({ code: "MODS_UI_STALE_ACTION" })
})

it("bounds concurrent real mounts and retires the old singleton routing alias", async () => {
  const f = fixture()
  const mounts = Array.from({ length: 32 }, () =>
    f.sites.mount("/project", "thread", "AssistantMessage")
  )
  await expect(f.sites.mount("/project", "thread", "AssistantMessage")).rejects.toMatchObject({
    code: "MODS_UI_SITE_MOUNT_CAPACITY"
  })
  const owners = await Promise.all(mounts)
  expect(new Set(owners).size).toBe(32)
  const before = await f.sites.mount("/project", "thread", "PromptHint")
  const after = await f.sites.mount("/project", "thread", "PromptHint")
  expect(f.sites.has(before)).toBe(false)
  expect(f.sites.has(after)).toBe(true)
  for (const owner of [...owners, after]) await f.sites.unmount("/project", "thread", owner)
  expect(f.sites.workspaces()).toEqual([])
})

const question: UserInputRequest = {
  requestId: "request-one",
  threadId: "thread",
  createdAt: "2026-10-04",
  questions: [
    {
      id: "question",
      header: "Header",
      question: "PRIVATE_BODY",
      options: [
        { label: "Keep", description: "PRIVATE_BODY" },
        { label: "Change", description: "PRIVATE_BODY" }
      ]
    }
  ]
}

it("pins Ask to the actual request object, ignores display attempts to select R2 and refuses ABA", async () => {
  const f = fixture()
  f.setQuestion(question)
  await expect(
    f.sites.mount("/project", "thread", "AskUserQuestion", undefined, "request-two")
  ).rejects.toMatchObject({ code: "MODS_UI_QUESTION_STALE" })
  const owner = await f.sites.mount(
    "/project",
    "thread",
    "AskUserQuestion",
    undefined,
    question.requestId
  )
  const frame = await f.sites.render("/project", "thread", owner, {
    tool: "request_user_input",
    questions: JSON.parse(
      JSON.stringify([{ ...question.questions[0], question: "FORGED" }])
    ) as ModJson
  })
  expect(frame.nativeContent?.requestId).toBe(question.requestId)
  expect(JSON.stringify(frame.nativeContent)).toContain("SAFE_BODY")
  expect(JSON.stringify(frame.nativeContent)).not.toContain("FORGED")
  f.setQuestion({ ...question })
  await expect(
    f.sites.render("/project", "thread", owner, {
      tool: "request_user_input",
      questions: JSON.parse(JSON.stringify(question.questions)) as ModJson
    })
  ).rejects.toMatchObject({ code: "MODS_UI_QUESTION_STALE" })
})

function managerFixture(omitProtection = false) {
  const root = mkdtempSync(join(tmpdir(), "function-host-sites-"))
  const control = new ModControlStore(join(root, "control.sqlite"))
  let enabled = true,
    protects = true,
    incarnation = "actual-one"
  const createClient = vi.fn(() => {
    throw Error("Unexpected guest allocation")
  })
  const publisher = vi.fn(async (_workspace: string, value: ModJson) => redact(value))
  const manager = new FunctionModsManager(
    control,
    {
      plugins: () => [],
      enabled: () => enabled,
      ...(omitProtection ? {} : { protects: () => protects }),
      captureSiteGuard: () => {
        const expected = incarnation
        return () => {
          if (incarnation !== expected) throw new ModFunctionError("MODS_SCOPE_CHANGED")
        }
      },
      publish: publisher,
      changed: vi.fn(),
      pendingQuestion: () => question
    },
    createClient
  )
  close.push(() => {
    manager.close()
    control.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    manager,
    createClient,
    publisher,
    configure(on: boolean, policy: boolean) {
      enabled = on
      protects = policy
      manager.invalidate(root)
    },
    changeNativeEnabled(on: boolean) {
      enabled = on
    },
    rebind() {
      incarnation = "actual-two"
    }
  }
}

it.each([true, false])(
  "manager mounts a truly protected native slot without guests when functions enabled=%s",
  async (enabled) => {
    const f = managerFixture()
    f.configure(enabled, true)
    const result = await f.manager.siteMountOutcome(f.root, "thread", "AssistantMessage")
    expect(result.state).toBe("mounted")
    if (result.state !== "mounted") throw Error("mount required")
    const frame = await f.manager.siteRender(f.root, "thread", result.owner, {
      text: "PRIVATE_BODY",
      isFirstOfReply: true
    })
    expect(JSON.stringify(frame)).toContain("SAFE_BODY")
    expect(JSON.stringify(frame)).not.toContain("PRIVATE_BODY")
    expect(f.publisher).toHaveBeenCalled()
    expect(f.createClient).not.toHaveBeenCalled()
    f.manager.invalidateAll()
    await expect(
      f.manager.siteRender(f.root, "thread", result.owner, {
        text: "PRIVATE_BODY",
        isFirstOfReply: true
      })
    ).rejects.toMatchObject({ code: "MODS_UI_SITE_CLOSED" })
  }
)

it("manager only gives raw inactivity when both actual protection and usable functions are absent", async () => {
  const f = managerFixture()
  f.configure(true, false)
  expect(await f.manager.siteMountOutcome(f.root, "thread", "AssistantMessage")).toEqual({
    state: "inactive",
    reason: "no-protection-or-functions"
  })
  f.configure(false, false)
  expect(await f.manager.siteMountOutcome(f.root, "thread", "AssistantMessage")).toEqual({
    state: "inactive",
    reason: "mods-disabled"
  })
  expect(f.createClient).not.toHaveBeenCalled()
  expect(f.publisher).not.toHaveBeenCalled()
})

it("manager retains the mounted incarnation and legacy adapter never returns a raw result", async () => {
  const f = managerFixture()
  const owner = await f.manager.siteMount(f.root, "thread", "AssistantMessage")
  expect(owner).toBeTypeOf("string")
  f.rebind()
  await expect(
    f.manager.siteRender(f.root, "thread", owner!, { text: "PRIVATE_BODY", isFirstOfReply: true })
  ).rejects.toMatchObject({ code: "MODS_SCOPE_CHANGED" })
  expect(f.publisher).not.toHaveBeenCalled()
})

it("new mount outcomes refuse unknown protection instead of authorizing raw inactivity", async () => {
  const f = managerFixture(true)
  for (const enabled of [true, false]) {
    f.configure(enabled, false)
    await expect(
      f.manager.siteMountOutcome(f.root, "thread", "AssistantMessage")
    ).rejects.toMatchObject({ code: "MODS_UI_SITE_PROTECTION_REQUIRED" })
    expect(await f.manager.siteMount(f.root, "thread", "AssistantMessage")).toBeNull()
  }
  expect(f.publisher).not.toHaveBeenCalled()
  expect(f.createClient).not.toHaveBeenCalled()
})

it("retires the actual undelivered owner when native admission changes after mount", async () => {
  const f = managerFixture()
  const actualMount = FunctionUiSites.prototype.mount
  let allocated: string | undefined
  const mounted = vi.spyOn(FunctionUiSites.prototype, "mount").mockImplementation(async function (
    this: FunctionUiSites,
    ...args: Parameters<FunctionUiSites["mount"]>
  ) {
    const owner = await actualMount.apply(this, args)
    allocated = owner
    f.changeNativeEnabled(false)
    return owner
  })
  try {
    await expect(
      f.manager.siteMountOutcome(f.root, "thread", "AssistantMessage")
    ).rejects.toMatchObject({ code: "MODS_SCOPE_CHANGED" })
    expect(allocated).toBeTypeOf("string")
    await expect(
      f.manager.siteRender(f.root, "thread", allocated!, {
        text: "PRIVATE_BODY",
        isFirstOfReply: true
      })
    ).rejects.toMatchObject({ code: "MODS_UI_SITE_CLOSED" })
    expect(f.publisher).not.toHaveBeenCalled()
    expect(f.createClient).not.toHaveBeenCalled()
  } finally {
    mounted.mockRestore()
  }
})
