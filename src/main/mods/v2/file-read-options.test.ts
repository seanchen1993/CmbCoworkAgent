import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { ProjectFunctionFiles } from "./file-access"
import type { ModJson } from "../../../shared/mods/types"

const sessions: FunctionSession[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  for (const root of roots.splice(0)) {
    if (
      dirname(root) !== (await realpath(tmpdir())) ||
      !basename(root).startsWith("mods-read-options-")
    )
      throw Error("Unexpected read options cleanup path")
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(expression: string, rewrite = "e",
  publish: (value: ModJson) => Promise<ModJson> = async value => value,
  traceHooks?: number) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mods-read-options-")))
  roots.push(root)
  await writeFile(join(root, "note.txt"), "actual text SECRET 中文")
  const queries: string[] = []
  const publications: unknown[] = []
  const files = new ProjectFunctionFiles(
    root,
    () => {},
    async (value) => {
      publications.push(value)
      return typeof value === "string" ? value.replace("SECRET", "[filtered]") : value
    },
    async (tool) => {
      queries.push(tool)
      return { decision: "allow" }
    }
  )
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    const observed=[],traceChecks=[];
    on("session.start",async($,e,next)=>{await $.command.register({name:"read",description:"read"});return next(e)});
    ${traceHooks === undefined
      ? `on("fs.read",($,e,next)=>{observed.push(e);return next(${rewrite})});`
      : `for(let i=0;i<${traceHooks};i++)on("fs.read",{as:"bytes"},async($,e,next)=>{
        observed.push(e);const result=await next(e);
        traceChecks.push({hook:i,resultKeys:Object.keys(result),traceFrozen:Object.isFrozen(next.trace),
          entries:next.trace.map(row=>({index:row.index,plugin:row.plugin,tier:row.tier,
            event:row.event,outcome:row.outcome,received:row.received,
            keys:Object.keys(row).sort(),returnedKeys:Object.keys(row.returned),
            valueKeys:Object.keys(row.returned.value),same:row.returned.value.base64===result.value.base64,
            msValid:typeof row.ms==="number"&&row.ms>=0,
            frozen:Object.isFrozen(row)&&Object.isFrozen(row.returned)&&Object.isFrozen(row.returned.value)}))});
        return result;
      });`}
    on("command.run",{command:"read"},async $=>{
      try {const value=${expression};return {text:JSON.stringify({value,observed})}}
      catch(error){return {text:JSON.stringify({error:String(error.message),observed})}}
    })
  }}`)
  const session = new FunctionSession(
    [{ name: "read-options", root, tier: "user", guest, capabilities: [...SESSION_CAPABILITIES] }],
    {
      threadId: "read-options",
      workspace: root,
      assertLive: () => {},
      publish,
      files: () => files
    }
  )
  sessions.push(session)
  return {
    root,
    queries,
    publications,
    run: async () => JSON.parse(String((await session.run("read", "")).text))
  }
}

it.each(["", ", undefined", ", {}", ', {as:"text"}'])(
  "publishes actual filtered text and preserves the read mode for hooks (%s)",
  async (options) => {
    const f = await fixture(`await $.fs.read("note.txt"${options})`)
    expect(await f.run()).toEqual({
      value: "actual text [filtered] 中文",
      observed: [{ path: join(f.root, "note.txt"), as: "text" }]
    })
    expect(f.publications).toEqual(["actual text SECRET 中文"])
    expect(f.queries.length).toBeGreaterThan(0)
    expect(f.queries.every((tool) => tool === "host:read_file")).toBe(true)
  }
)

it.each([
  "null",
  "[]",
  "true",
  '{as:"binary"}',
  "{as:null}",
  '{as:"text",unknown:true}',
  '{as:"text"}, "extra"'
])("rejects malformed read options before opening the file (%s)", async (options) => {
  const f = await fixture(`await $.fs.read("note.txt",${options})`)
  expect(await f.run()).toEqual({ error: "MODS_FS_OPTIONS", observed: [] })
  expect(f.queries).toEqual([])
  expect(f.publications).toEqual([])
})

it("returns the official bytes object through real guest and host boundaries without UTF-8 loss", async () => {
  const f = await fixture('await $.fs.read("note.txt",{as:"bytes"})')
  const bytes = Buffer.from([0, 255, 128, 13, 10, 42])
  await writeFile(join(f.root, "note.txt"), bytes)
  const expected = { base64: bytes.toString("base64") }
  expect(await f.run()).toEqual({
    value: expected,
    observed: [{ path: join(f.root, "note.txt"), as: "bytes" }]
  })
  expect(f.queries.length).toBeGreaterThan(0)
  expect(f.publications).toEqual([expected])
})

it.each([400 * 1024, 512 * 1024])("decodes %i bytes read through the complete guest and host path", async size => {
  const f = await fixture('(await (async()=>{const value=await $.fs.read("note.txt",{as:"bytes"});const decoded=atob(value.base64);return {length:decoded.length,first:decoded.charCodeAt(0),last:decoded.charCodeAt(decoded.length-1)}})())')
  const bytes = Buffer.alloc(size, 255)
  bytes[0] = 0
  await writeFile(join(f.root, "note.txt"), bytes)
  const result = await f.run()
  expect(result).toEqual({
    value: { length: size, first: 0, last: 255 },
    observed: [{ path: join(f.root, "note.txt"), as: "bytes" }]
  })
})

it.each([1, 2])("preserves exact public next.trace through %i hooks for 512 KiB bytes", async hookCount => {
  const f = await fixture(`(await (async()=>{
    const value=await $.fs.read("note.txt",{as:"bytes"});const decoded=atob(value.base64);
    return {length:decoded.length,first:decoded.charCodeAt(0),last:decoded.charCodeAt(decoded.length-1),traceChecks};
  })())`, "e", async value => value, hookCount)
  const bytes = Buffer.alloc(512 * 1024, 255)
  bytes[0] = 0
  await writeFile(join(f.root, "note.txt"), bytes)
  const received = { path: join(f.root, "note.txt"), as: "bytes" }
  const expected = Array.from({ length: hookCount }, (_, offset) => {
    const hook = hookCount - offset - 1
    return {
      hook, resultKeys: ["value"], traceFrozen: true,
      entries: Array.from({ length: hookCount - hook }, (_, nextOffset) => {
        const index = hook + nextOffset + 1
        const core = index === hookCount
        return {
          index, plugin: core ? "engine" : "read-options", tier: core ? "core" : "user",
          event: "fs.read", outcome: "returned", received,
          keys: ["event", "index", "ms", "outcome", "plugin", "received", "returned", "tier"],
          returnedKeys: ["value"], valueKeys: ["base64"], same: true, msValid: true, frozen: true
        }
      })
    }
  })
  expect(await f.run()).toEqual({
    value: { length: bytes.length, first: 0, last: 255, traceChecks: expected },
    observed: Array.from({ length: hookCount }, () => received)
  })
})

it.each(["[REDACTED]", Buffer.from("substituted bytes").toString("base64")])(
  "refuses changed bytes at the final Session publisher (%s)", async base64 => {
    const f = await fixture('await $.fs.read("note.txt",{as:"bytes"})', "e", async value => {
      if (value && typeof value === "object" && !Array.isArray(value) &&
        value.value && typeof value.value === "object" && !Array.isArray(value.value) &&
        typeof value.value.base64 === "string") {
        // Exercise an in-place policy as well: the expected bytes must be captured first.
        value.value.base64 = base64
      }
      return value
    })
    expect((await f.run()).error).toContain("MODS_FS_BYTES_POLICY")
  }
)

it.each(['"binary"', "null"])(
  "validates mode rewritten by a real operation hook before host I/O (%s)",
  async (as) => {
    const f = await fixture('await $.fs.read("note.txt")', `{...e,as:${as}}`)
    const result = await f.run()
    expect(result.error).toContain("MODS_FS_OPTIONS")
    expect(f.queries).toEqual([])
    expect(f.publications).toEqual([])
  }
)

it("keeps legacy path-only hook rewrites working through mandatory text publication", async () => {
  const f = await fixture('await $.fs.read("note.txt",{as:"text"})', "{path:e.path}")
  expect((await f.run()).value).toBe("actual text [filtered] 中文")
  expect(f.publications).toHaveLength(1)
})
