import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { ProjectFunctionFiles } from "./file-access"

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

async function fixture(expression: string, rewrite = "e") {
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
    const observed=[];
    on("session.start",async($,e,next)=>{await $.command.register({name:"read",description:"read"});return next(e)});
    on("fs.read",($,e,next)=>{observed.push(e);return next(${rewrite})});
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
      publish: async (value) => value,
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

it("rejects unsupported byte mode without returning a lossy text substitute", async () => {
  const f = await fixture('await $.fs.read("note.txt",{as:"bytes"})')
  expect(await f.run()).toEqual({ error: "MODS_FS_BYTES_UNSUPPORTED", observed: [] })
  expect(f.queries).toEqual([])
  expect(f.publications).toEqual([])
})

it.each(['"bytes"', '"binary"', "null"])(
  "validates mode rewritten by a real operation hook before host I/O (%s)",
  async (as) => {
    const f = await fixture('await $.fs.read("note.txt")', `{...e,as:${as}}`)
    const result = await f.run()
    expect(result.error).toContain(
      as === '"bytes"' ? "MODS_FS_BYTES_UNSUPPORTED" : "MODS_FS_OPTIONS"
    )
    expect(f.queries).toEqual([])
    expect(f.publications).toEqual([])
  }
)

it("keeps legacy path-only hook rewrites working through mandatory text publication", async () => {
  const f = await fixture('await $.fs.read("note.txt",{as:"text"})', "{path:e.path}")
  expect((await f.run()).value).toBe("actual text [filtered] 中文")
  expect(f.publications).toHaveLength(1)
})
