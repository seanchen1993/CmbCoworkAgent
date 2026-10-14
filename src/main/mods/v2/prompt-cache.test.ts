import { afterEach, expect, it } from "vitest"
import { ModRuntimeAuthorities } from "../runtime-instance"
import { FunctionPromptCache, bindHostPromptOccurrence, hostPromptOccurrence } from "./prompt-cache"

const owners: ModRuntimeAuthorities[] = []
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.close())
})
function owner(agentId = "main") {
  const registry = new ModRuntimeAuthorities()
  owners.push(registry)
  return {
    registry,
    ...registry.create({ workspace: "/p", threadId: "t", turnId: "turn", agentId })
  }
}
const event = "prompt.attachment"
const input = { type: "output_style", text: "BODY", origin: { kind: "engine" } }

it("isolates identical text by actual owner and genuine occurrence, caching null too", () => {
  const cache = new FunctionPromptCache()
  const main = owner()
  const child = owner("child")
  const source = {}
  cache.write(event, main.authority, source, input, { text: null }, cache.generation(event))
  expect(cache.read(event, main.authority, source, input)).toEqual({ text: null })
  expect(cache.read(event, child.authority, source, input)).toBeUndefined()
  expect(cache.read(event, main.authority, {}, input)).toBeUndefined()
})

it("invalidates only the target event and prevents a late old generation from replacing new data", () => {
  const cache = new FunctionPromptCache()
  const { authority } = owner()
  const source = {}
  const old = cache.generation(event)
  cache.write("prompt.context", authority, source, { blocks: [] }, { blocks: [] }, 0)
  cache.invalidate(event)
  cache.write(event, authority, source, input, { text: "CURRENT" }, cache.generation(event))
  cache.write(event, authority, source, input, { text: "LATE" }, old)
  expect(cache.read(event, authority, source, input)).toEqual({ text: "CURRENT" })
  expect(cache.read("prompt.context", authority, source, { blocks: [] })).toEqual({ blocks: [] })
})

it("does not retain caller mutations or re-admit a source whose body changed", () => {
  const cache = new FunctionPromptCache()
  const { authority } = owner()
  const source = {}
  const value = { text: "VALID" }
  cache.write(event, authority, source, input, value, 0)
  value.text = "CALLER_MUTATED"
  const hit = cache.read(event, authority, source, input)!
  hit.text = "READER_MUTATED"
  expect(cache.read(event, authority, source, input)).toEqual({ text: "VALID" })
  expect(cache.read(event, authority, source, { ...input, text: "DIFFERENT" })).toBeUndefined()
  cache.write(event, authority, source, input, { text: "REUSED" }, 0)
  expect(cache.read(event, authority, source, input)).toBeUndefined()
})

it("refuses revoked owners and never recognizes a guest-supplied source label", () => {
  const cache = new FunctionPromptCache()
  const { authority, registry } = owner()
  const source = {}
  const core = async () => ({ text: "BODY" })
  expect(hostPromptOccurrence(core, event)).toBeUndefined()
  bindHostPromptOccurrence(core, event, source)
  expect(hostPromptOccurrence(core, "prompt.context")).toBeUndefined()
  expect(hostPromptOccurrence(core, event)).toBe(source)
  registry.close()
  expect(() => cache.read(event, authority, source, input)).toThrow(/MODS_RUNTIME/)
  expect(() => cache.write(event, authority, source, input, { text: null }, 0)).toThrow(
    /MODS_RUNTIME/
  )
})
