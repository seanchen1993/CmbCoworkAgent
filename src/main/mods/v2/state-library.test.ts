import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { ModJson, ModObject } from "../../../shared/mods/types"

const roots: string[] = []
async function compile(body: string, source = "") {
  const root = await mkdtemp(join(tmpdir(), "mods-state-library-"))
  roots.push(root)
  await mkdir(join(root, "hooks"))
  await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "state-library" }))
  await writeFile(join(root, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
  await writeFile(
    join(root, "hooks/register.ts"),
    `${source || 'import {atom,derive,read,update,memberOf} from "claude-code"'}
    export function register(on){on("command.run",async($,e)=>{${body}})}`
  )
  return compileFunctionPlugin(root)
}
async function run(body: string, options: { misses?: number; error?: string } = {}) {
  const plugin = await compile(body)
  const guest = await FunctionGuestRuntime.create(plugin.code)
  const values = new Map<string, { value: ModJson; version: number }>()
  let gets = 0
  let sets = 0
  try {
    const result = await guest.invoke(
      "0",
      {},
      async (method, raw) => {
        const args = raw as ModJson[]
        const key = JSON.stringify(args[0])
        const held = values.get(key) ?? { version: 0 }
        if (method === "state.get") {
          gets++
          return { value: held }
        }
        if (method !== "state.set") throw Error("unexpected SDK")
        sets++
        if (options.error) throw Error(options.error)
        if (sets <= (options.misses ?? 0)) {
          values.set(key, { value: 10, version: sets })
          return { value: { isSet: false, version: sets } }
        }
        const expected = (args[2] as ModObject)?.ifVersion
        if (expected !== undefined && expected !== held.version)
          return { value: { isSet: false, version: held.version } }
        const version = held.version + 1
        values.set(key, { value: args[1], version })
        return { value: { isSet: true, version } }
      },
      {
        event: "command.run",
        origin: { plugin: "engine", tier: "core" },
        capabilities: ["state.get", "state.set"],
        plugin: { name: "state-library", root: plugin.root }
      }
    )
    return { result: result.value, values, gets, sets }
  } finally {
    guest.dispose()
  }
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe("compiled claude-code state helpers in isolated guest", () => {
  it("resolves platform and compatibility names to the same isolated helper instance", async () => {
    const plugin = await compile(
      "return {same:atom===compatibleAtom}",
      'import {atom} from "devclaw-mods";import {atom as compatibleAtom} from "claude-code"'
    )
    const guest = await FunctionGuestRuntime.create(plugin.code)
    try {
      const result = await guest.invoke("0", {}, async () => { throw Error("No host calls") }, {
        event: "command.run", origin: { plugin: "engine", tier: "core" }, capabilities: [],
        plugin: { name: plugin.name, root: plugin.root }
      })
      expect(result.value).toMatchObject({ same: true })
    } finally {
      guest.dispose()
    }
    await expect(compile('return import("devclaw-mods")')).rejects.toThrow("MODS_IMPORT_DENIED")
    await expect(compile("return 1", 'import {atom} from "devclaw-mods/extra";atom()'))
      .rejects.toThrow("MODS_IMPORT_DENIED")
  })
  it("copies refs, freezes nested initial and preserves null versus absence", async () => {
    const { result } = await run(`
      const ref={plugin:"state-library",key:"count"};
      const initial=Object.freeze({child:{items:[1]}});
      const a=atom(ref,initial); ref.key="other";
      const frozen=[a,a.ref,initial,initial.child,initial.child.items].every(Object.isFrozen);
      const before=await read($,a);
      await $.state.set(a.ref,null);
      return {frozen,key:a.ref.key,before,after:await read($,a)};
    `)
    expect(result).toEqual({
      frozen: true,
      key: "count",
      before: { child: { items: [1] } },
      after: null
    })
  })
  it("does not overwrite an old shape until an explicit update", async () => {
    const { result } = await run(`
      const ref={plugin:"state-library",key:"shape"};
      await $.state.set(ref,{shape:"v1",value:99});
      const a=atom(ref,3,{shape:"v2"});
      const before=await read($,a), raw=await $.state.get(ref);
      const changed=await update($,a,n=>n+1);
      return {before,raw:raw.value,changed,after:(await $.state.get(ref)).value};
    `)
    expect(result).toEqual({
      before: 3,
      raw: { shape: "v1", value: 99 },
      changed: 4,
      after: { shape: "v2", value: 4 }
    })
  })
  it("binds family members without mutating the family or sharing values", async () => {
    const { result } = await run(`
      const family=atom({plugin:"state-library",key:"family"},0,{shape:"v1"});
      const a=memberOf(family,{requestId:"a"}),b=memberOf(family,{requestId:"b"});
      await update($,a,n=>n+1);
      return {a:await read($,a),b:await read($,b),family:family.ref,
        raw:memberOf({plugin:"state-library",key:"raw"},{requestId:"row"})};
    `)
    expect(result).toEqual({
      a: 1,
      b: 0,
      family: { plugin: "state-library", key: "family" },
      raw: { plugin: "state-library", key: "raw", id: "row" }
    })
  })
  it("caches nested derives by versions but still reads every dependency on cache hits", async () => {
    const { result, gets } = await run(`
      const a=atom({plugin:"state-library",key:"count"},1);let computes=0;
      const doubled=derive([a],n=>{computes++;return n*2});
      const total=derive([doubled,a],(n,m)=>n+m);
      const first=await read($,total), second=await read($,total);
      await $.state.set(a.ref,1);
      const third=await read($,total);
      return {first,second,third,computes};
    `)
    expect(result).toEqual({ first: 3, second: 3, third: 3, computes: 2 })
    expect(gets).toBe(6)
  })
  it("computes an empty derived value once", async () => {
    expect(
      (
        await run(`let n=0;const d=derive([],()=>++n);
      return [await read($,d),await read($,d),n];`)
      ).result
    ).toEqual([1, 1, 1])
  })
  it("retries a CAS miss with the new value", async () => {
    const { result, sets } = await run(
      `
      const a=atom({plugin:"state-library",key:"count"},0);
      return await update($,a,n=>n+1);
    `,
      { misses: 1 }
    )
    expect(result).toBe(11)
    expect(sets).toBe(2)
  })
  it("bounds conflict retries and propagates host failures without retry", async () => {
    const source = `const a=atom({plugin:"state-library",key:"count"},0);
      try {await update($,a,n=>n+1);return "unexpected"}catch(e){return String(e)}`
    const conflict = await run(source, { misses: 100 })
    expect(conflict.sets).toBe(64)
    expect(conflict.result).toContain("MODS_STATE_UPDATE_CONFLICT")
    const failure = await run(source, { error: "revoked" })
    expect(failure.sets).toBe(1)
    expect(failure.result).toContain("revoked")
  })
  it("does not lose concurrent increments", async () => {
    const { result } = await run(`
      const a=atom({plugin:"state-library",key:"count"},0);
      await Promise.all([update($,a,n=>n+1),update($,a,n=>n+1)]);
      return await read($,a);
    `)
    expect(result).toBe(2)
  })
  it("admits only supported static module exports and keeps other imports denied", async () => {
    await expect(
      compile("return 1", 'import {missing} from "claude-code";missing()')
    ).rejects.toThrow()
    await expect(compile('return import("claude-code")')).rejects.toThrow("MODS_IMPORT_DENIED")
    await expect(compile("return 1", 'import x from "node:fs";x()')).rejects.toThrow(
      "MODS_IMPORT_DENIED"
    )
    await expect(
      compile("return 1", 'import {atom} from "claude-code/extra";atom()')
    ).rejects.toThrow("MODS_IMPORT_DENIED")
  })
})
