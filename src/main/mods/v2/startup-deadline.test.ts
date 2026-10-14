import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const sessions: FunctionSession[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})

async function fixture(body: string) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  const session = new FunctionSession(
    [
      {
        name: "deadline",
        root: "/deadline",
        tier: "user",
        capabilities: [...SESSION_CAPABILITIES],
        guest
      }
    ],
    {
      workspace: "/workspace",
      threadId: "thread",
      assertLive: () => {},
      publish: async (value) => value
    }
  )
  sessions.push(session)
  return { session, guest }
}

it("a shared host startup deadline rejects an unfinished optional hook instead of admitting fallback", async () => {
  const f = await fixture('on("session.start",async()=>new Promise(()=>{}))')
  const real = setTimeout
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => real(handler, delay === 120000 ? 40 : delay, ...args)) as typeof setTimeout)
  const first = f.session.start()
  expect(f.session.start()).toBe(first)
  await expect(first).rejects.toMatchObject({ code: "MODS_STARTUP_TIMEOUT" })
  expect(f.guest.stats.frames).toBe(0)
  await expect(f.session.start()).rejects.toMatchObject({ code: "MODS_STARTUP_TIMEOUT" })
})

it("explicit close cancels the shared startup chain and disposes its active frame", async () => {
  const f = await fixture('on("session.start",async()=>new Promise(()=>{}))')
  const pending = f.session.start()
  const assertion = expect(pending).rejects.toThrow()
  await new Promise((done) => setTimeout(done, 30))
  await f.session.close()
  await assertion
  expect(f.guest.stats).toMatchObject({ disposed: true, frames: 0 })
})

it("extending host wait does not grant a startup hook more QuickJS CPU time", async () => {
  const f = await fixture('on("session.start",()=>{while(true){};return {cwd:"/workspace"}})')
  const start = performance.now()
  // The existing optional policy may bypass the handler; the infinite loop still cannot continue.
  await f.session.start().catch(() => {})
  expect(f.guest.stats.frames).toBe(0)
  expect(await f.session.commands()).toEqual([])
  expect(performance.now() - start).toBeLessThan(1500)
})

it("the same host deadline covers the engine build before startup hooks", async () => {
  const f = await fixture(
    'on("engine.create",async()=>new Promise(()=>{}));on("session.start",async($,e,next)=>{await $.command.register({name:"wrong",description:"wrong"});return next(e)})'
  )
  const real = setTimeout
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => real(handler, delay === 120000 ? 40 : delay, ...args)) as typeof setTimeout)
  await expect(f.session.start()).rejects.toMatchObject({ code: "MODS_STARTUP_TIMEOUT" })
  expect(f.guest.stats.frames).toBe(0)
})
