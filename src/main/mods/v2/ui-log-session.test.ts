import { afterEach, expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionUiLog } from "./ui-log"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})

async function fixture(hooks: string, publish = async (value: ModJson): Promise<ModJson> => value) {
  let live = true
  const debugLog = vi.fn()
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${hooks}}}`)
  const session = new FunctionSession(
    [
      {
        name: "logging",
        root: "/logging",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      publish,
      debugLog,
      assertLive: () => {
        if (!live) throw Error("revoked")
      }
    }
  )
  sessions.push(session)
  await session.start()
  return {
    session,
    debugLog,
    revoke: () => {
      live = false
    }
  }
}

it("real guest ui.log is void, defaults to transcript and settles before hook return", async () => {
  const { session, debugLog } = await fixture(`
    on("session.start", ($, e, next) => {
      if ($.ui.log("one") !== undefined) throw Error("must be void");
      $.ui.log("private", {to:"debug"}); $.ui.log("three"); return next(e);
    });
  `)
  expect((await session.logSnapshot()).map((row) => row.text)).toEqual(["one", "three"])
  expect(debugLog.mock.calls).toEqual([
    ["logging", "one"],
    ["logging", "private"],
    ["logging", "three"]
  ])
})

it("runs operation rewrites and publication before either sink, retaining original log order", async () => {
  const { session, debugLog } = await fixture(
    `
    on("session.start", ($, e, next) => { $.ui.log("slow"); $.ui.log("hidden"); return next(e); });
    on("ui.log", ($, e, next) => next({...e, text:e.text+" secret", to:e.text==="hidden"?"debug":e.to}));
  `,
    async (value) => {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.text === "string"
      ) {
        if (value.text === "slow secret") await new Promise((r) => setTimeout(r, 25))
        return { ...value, text: value.text.replace("secret", "[redacted]") }
      }
      return value
    }
  )
  expect((await session.logSnapshot()).map((row) => row.text)).toEqual(["slow [redacted]"])
  expect(debugLog.mock.calls.map((row) => row[1])).toEqual(["slow [redacted]", "hidden [redacted]"])
})

it("denied logs reach neither transcript nor debug", async () => {
  const { session, debugLog } = await fixture(`
    on("session.start", async ($, e, next) => {
      await $.command.register({name:"log",description:"test"}); return next(e);
    });
    on("command.run", {command:"log"}, ($) => { $.ui.log("denied"); return {text:"done"}; });
    on("ui.log", () => ({deny:"no logging"}));
  `)
  await session.run("log", "")
  expect(await session.logSnapshot()).toEqual([])
  expect(debugLog).not.toHaveBeenCalled()
})

it.each(['{to:"network"}', "{to:null}", '{to:"transcript",plugin:"other"}', "null"])(
  "rejects invalid log options %s",
  async (options) => {
    const { session, debugLog } = await fixture(`
    on("session.start", async ($, e, next) => { await $.command.register({name:"invalid",description:"test"}); return next(e); });
    on("command.run", {command:"invalid"}, ($) => { $.ui.log("invalid", ${options}); return {text:"bad"}; });
  `)
    await session.run("invalid", "")
    expect(await session.logSnapshot()).toEqual([])
    expect(debugLog).not.toHaveBeenCalled()
  }
)

it("nested log hooks do not deadlock and skip their own calling registration", async () => {
  const { session, debugLog } = await fixture(`
    on("session.start", ($, e, next) => { $.ui.log("outer"); return next(e); });
    on("ui.log", ($, e, next) => { $.ui.log("nested",{to:"debug"}); return next(e); });
  `)
  expect((await session.logSnapshot()).map((row) => row.text)).toEqual(["outer"])
  expect(debugLog.mock.calls.map((row) => row[1])).toEqual(["outer", "nested"])
})

it("revocation hides logs and prevents late host reads", async () => {
  const f = await fixture(
    `on("session.start", ($,e,next) => { $.ui.log("line"); return next(e); });`
  )
  f.revoke()
  await expect(f.session.logSnapshot()).rejects.toThrow("revoked")
})

it("rejects a malformed publication snapshot instead of sending unusable rows to the renderer", async () => {
  const f = await fixture(
    `on("session.start", ($,e,next) => { $.ui.log("line"); return next(e); });`,
    async (value) => (Array.isArray(value) ? "invalid snapshot" : value)
  )
  await expect(f.session.logSnapshot()).rejects.toThrow("MODS_UI_LOG_SNAPSHOT")
})

it("parent cancellation discards an already settled nested log waiting behind its parent", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const blocked = new Promise<void>((resolve) => {
    entered = resolve
  })
  const settle = vi.spyOn(FunctionUiLog.prototype, "settle")
  try {
    const f = await fixture(
      `
      on("session.start", async ($, e, next) => { await $.command.register({name:"cancel-log",description:"test"}); return next(e); });
      on("command.run", {command:"cancel-log"}, ($) => { $.ui.log("outer"); return {text:"done"}; });
      on("ui.log", ($, e, next) => {
        if(e.text==="outer") { $.ui.log("nested",{to:"debug"}); return next({...e,text:"waiting"}); }
        return next(e);
      });
    `,
      async (value) => {
        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.keys(value).length === 0 &&
          settle.mock.calls.some((call) => call[1]?.text === "nested")
        ) {
          entered()
          await gate
        }
        return value
      }
    )
    const controller = new AbortController()
    const run = f.session.run("cancel-log", "", controller.signal).catch(() => ({}))
    await blocked
    await vi.waitFor(() =>
      expect(settle.mock.calls.some((call) => call[1]?.text === "nested")).toBe(true)
    )
    controller.abort(Error("cancelled parent"))
    release()
    await run
    expect(f.debugLog).not.toHaveBeenCalled()
    expect(await f.session.logSnapshot()).toEqual([])
  } finally {
    release?.()
    settle.mockRestore()
  }
})
