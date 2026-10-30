import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import * as loader from "../v2/loader"
import { checkCompiledFunctionAuthorTypes } from "./authoring-check"
import { analyzeAuthoringPreview } from "./authoring-preflight"
import { authoringValidationResult } from "./authoring-validation-result"

const roots: string[] = []
const validSource = `import type { Register } from "devclaw-mods"
export const register: Register = (on) => {
  on("command.run", async ($) => {
    await $.store.get("preview.value")
    return { text: "checked" }
  })
}`

async function fixture(source = validSource) {
  const root = await mkdtemp(join(tmpdir(), "cmb-authoring-preflight-check-"))
  roots.push(root)
  const files = {
    "plugin.json": JSON.stringify({ name: "preview-check", mods: "mods/manifest.json" }),
    "mods/manifest.json": JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "preview-check",
      entry: "main.ts"
    }),
    "mods/main.ts": source
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it("compiles once and checks both SDK and actual strict TypeScript from that captured source", async () => {
  const root = await fixture()
  const compile = vi.spyOn(loader, "compileFunctionPlugin")
  const result = await analyzeAuthoringPreview(root)
  expect(compile).toHaveBeenCalledExactlyOnceWith(root, { captureSources: true })
  expect(result.sdk.strictCompatible).toBe(true)
  expect(result.typecheck.valid).toBe(true)
  expect(result.typecheck.diagnostics).toEqual([])
  expect(result.typecheck.digest).toBe(result.compiled.digest)
  expect(result.sdk.digest).toBe(result.compiled.digest)
})

it("checks the actual Input, Select and Code authoring contract without permitting arbitrary props", async () => {
  const source = (body: string) => `import type { Register } from "devclaw-mods"
export const register: Register = on => {
  on("ui.render", {component:"Pane",requestId:"view"}, ($, event) => {
    const {Box,Input,Select,Code} = $.ui.resolve(event)
    ${body}
    return Box({children:[]})
  })
}`
  const valid = await analyzeAuthoringPreview(
    await fixture(
      source(`
    Input({key:"path",label:"Path",placeholder:"Directory",value:"",submitLabel:"Select",
      autoFocus:true,onSubmit:value=>value.toUpperCase(),onInput:value=>value.trim()})
    Select({key:"choice",label:"Choice",options:[{value:"one",label:"One"}],value:"one",
      autoFocus:true,onSelect:value=>value.toUpperCase()})
    Code({source:"+line",language:"diff",path:"file.txt",startLine:1,format:"diff",wrap:"wrap"})
  `)
    )
  )
  expect(valid.typecheck.valid, JSON.stringify(valid.typecheck.diagnostics)).toBe(true)
  expect(valid.sdk.strictCompatible).toBe(true)
  const invalid = await analyzeAuthoringPreview(
    await fixture(
      source(`
    Input({key:"bad-prop",onSubmit:value=>value,style:"unsafe"})
    Input({key:"bad-event",onSubmit:(value:number)=>value})
    Input({key:"missing-submit",onInput:value=>value})
    Input({key:"false-focus",autoFocus:false,onSubmit:value=>value})
    Select({key:"bad-select",options:[{value:"one",label:"One"}],onChange:(value:string)=>value})
    Select({key:"bad-option",options:[{value:1,label:"One"}],onSelect:value=>value})
    Select({key:"false-focus",options:[{value:"one",label:"One"}],autoFocus:false,onSelect:value=>value})
    Code({source:"line",format:"html"})
    Code({source:"line",wrap:"scroll"})
    Code({source:"line",onPress:()=>"unexpected"})
  `)
    )
  )
  expect(invalid.typecheck.valid).toBe(false)
  const diagnostics = invalid.typecheck.diagnostics.map((item) => item.message).join("\n")
  for (const rejected of [
    "style",
    "number",
    "onSubmit",
    "onChange",
    "html",
    "scroll",
    "onPress",
    "false"
  ])
    expect(diagnostics).toContain(rejected)
})

it("still reports real type errors after the single compile and never reuses a prior candidate", async () => {
  const root = await fixture()
  const compile = vi.spyOn(loader, "compileFunctionPlugin")
  const valid = await analyzeAuthoringPreview(root)
  await writeFile(
    join(root, "mods/main.ts"),
    validSource + "\nconst wrong: string = 42\nvoid wrong\n"
  )
  const invalid = await analyzeAuthoringPreview(root)
  expect(compile).toHaveBeenCalledTimes(2)
  expect(valid.typecheck.valid).toBe(true)
  expect(invalid.compiled.digest).not.toBe(valid.compiled.digest)
  expect(invalid.typecheck.valid).toBe(false)
  expect(invalid.typecheck.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ file: "mods/main.ts", message: expect.stringContaining("number") })
    ])
  )
})

it("does not admit a type-correct SDK escape through the shared source snapshot", async () => {
  const root = await fixture(
    validSource.replace(
      'await $.store.get("preview.value")',
      'const relay = (sdk: typeof $) => ({ sdk }); await relay($)'
    )
  )
  const compile = vi.spyOn(loader, "compileFunctionPlugin")
  const result = await analyzeAuthoringPreview(root)
  expect(compile).toHaveBeenCalledTimes(1)
  expect(result.typecheck.valid).toBe(true)
  expect(result.sdk.strictCompatible).toBe(false)
  expect(result.sdk.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "MODS_SDK_UNVERIFIED", file: "mods/main.ts" })
    ])
  )
  const checked = authoringValidationResult("b".repeat(64), result)
  expect(checked.valid).toBe(false)
  expect(checked.runtimeVerified).toBe(false)
  expect(checked.repairHints).toHaveLength(1)
  expect(checked.repairHints?.[0]).toContain("不要把 SDK 对象或方法传给")
  expect(checked.repairHints?.[0]).toContain("先按具体诊断区分原因")
  expect(checked.repairHints?.[0]).toContain("不要猜测或反复更改工具名")
  expect(checked.repairHints?.[0]).toContain("catalog(query:'platform.act'")
  expect(checked.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ file: "mods/main.ts", code: "MODS_SDK_UNVERIFIED" })
    ])
  )
})

it("admits a type-correct captured helper while retaining the exact compile identity", async () => {
  const root = await fixture('import { install } from "./helpers"\nexport const register = install')
  await writeFile(join(root, "mods/helpers.ts"), `import type { Register, SDK } from "devclaw-mods"
    export const install: Register = on => {
      on("command.run", async sdk => { await readValue(sdk, "preview.value"); return {text:"checked"} })
    }
    async function readValue(sdk: Pick<SDK, "store">, key: string) { return sdk.store.get(key) }
  `)
  const compile = vi.spyOn(loader, "compileFunctionPlugin")
  const result = await analyzeAuthoringPreview(root)
  expect(compile).toHaveBeenCalledTimes(1)
  expect(result.typecheck.valid, JSON.stringify(result.typecheck.diagnostics)).toBe(true)
  expect(result.sdk.strictCompatible, JSON.stringify(result.sdk.diagnostics)).toBe(true)
  expect(result.sdk.digest).toBe(result.compiled.digest)
  expect(authoringValidationResult(result.compiled.digest, result)).toMatchObject({
    valid: true, runtimeVerified: false, capabilities: ["store.get"]
  })
})

it("checks the captured candidate without reading later edits from its source directory", async () => {
  const root = await fixture()
  const compile = loader.compileFunctionPlugin
  const observed = vi.spyOn(loader, "compileFunctionPlugin").mockImplementation(async (...args) => {
    const snapshot = await compile(...args)
    await writeFile(join(root, "mods/main.ts"), "export function register() { process.exit() }")
    return snapshot
  })
  const result = await analyzeAuthoringPreview(root)
  expect(observed).toHaveBeenCalledTimes(1)
  expect(result.typecheck.valid).toBe(true)
  expect(result.sdk.strictCompatible).toBe(true)
  expect(result.typecheck.digest).toBe(result.compiled.digest)
})

it("requires captured source for the compiled-input checker rather than reading it from disk", async () => {
  const compiled = await loader.compileFunctionPlugin(await fixture())
  expect(compiled.authoringSources).toBeUndefined()
  await expect(checkCompiledFunctionAuthorTypes(compiled)).rejects.toThrow(
    "AUTHORING_SOURCE_SNAPSHOT_REQUIRED"
  )
})
