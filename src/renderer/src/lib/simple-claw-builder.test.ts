import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import type { ClawProfile } from "../../../shared/mods/claw"
import type { SavedFlow } from "../../../shared/mods/flows/types"
import {
  buildSimpleFlow,
  saveSimpleCombination,
  simpleConnections,
  simpleSchemaCompatible,
  simpleProfileSupported,
  type SimpleSaveCheckpoint
} from "./simple-claw-builder"
import { createPracticeIntent, sameSimpleAuthoringScope } from "./simple-authoring-intent"

const manifest = (path: string) => JSON.parse(readFileSync(path, "utf8"))
const producer = manifest("examples/autobiz-fullstack-mods/mods/manifest.json").claw.actions[0]
const consumer = manifest("examples/mods-review-agent/plugin.json").claw.actions[0]
const action = (value: typeof producer, id: string): ClawActionDescriptor => ({
  ...value,
  pluginId: id,
  plugin: id,
  digest: "a".repeat(64),
  actionId: value.id
})
const actions: [ClawActionDescriptor, ClawActionDescriptor] = [
  action(producer, "autobiz"),
  action(consumer, "review")
]
const profile: ClawProfile = {
  id: "mine",
  name: "文件检视",
  capabilities: [],
  models: { default: "configured-model", roles: {} },
  skills: { mode: "all", items: [] }
}
const definition = () =>
  buildSimpleFlow({
    id: "flow",
    name: "文件检视",
    actions,
    inputs: [{ feature: "REAL-1", path: "src/cart.ts" }, {}],
    configs: [{}, {}],
    connection: ""
  })

describe("simple combination", () => {
  it("connects the real AutoBiz and Review schemas without fabricating fields", () => {
    expect(simpleConnections(producer.outputSchema, consumer.inputSchema)).toEqual([
      { path: "", label: "完整输出" }
    ])
    const flow = definition()
    expect(flow.steps[0]).toMatchObject({ input: { feature: "REAL-1", path: "src/cart.ts" } })
    expect(flow.steps[1]).toMatchObject({ input: {}, inputFrom: { stepId: "step-1", path: "" } })
  })
  it("does not offer unproved type, required, or string-bound compatibility", () => {
    const target = structuredClone(consumer.inputSchema)
    const source = structuredClone(producer.outputSchema)
    source.properties.source.maxLength = 5000
    expect(simpleSchemaCompatible(source, target)).toBe(false)
    source.properties.source.maxLength = 4000
    source.required = source.required.filter((key: string) => key !== "source")
    expect(simpleSchemaCompatible(source, target)).toBe(false)
    expect(simpleConnections(undefined, target)).toEqual([])
    expect(simpleSchemaCompatible({ type: "object", $ref: "unknown" }, target)).toBe(false)
  })
  it("requires every parent of a nested output path to guarantee its child", () => {
    const payload = structuredClone(producer.outputSchema)
    const output = {
      type: "object",
      required: [] as string[],
      additionalProperties: false,
      properties: {
        envelope: {
          type: "object",
          required: ["payload"],
          additionalProperties: false,
          properties: { payload }
        }
      }
    }
    expect(simpleConnections(output, consumer.inputSchema)).toEqual([])
    output.required = ["envelope"]
    output.properties.envelope.required = []
    expect(simpleConnections(output, consumer.inputSchema)).toEqual([])
    output.properties.envelope.required = ["payload"]
    expect(simpleConnections(output, consumer.inputSchema)).toEqual([
      { path: "/envelope/payload", label: "/envelope/payload" }
    ])
  })
  it("does not trust undeclared optional fields from an open producer object", () => {
    const input = {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        context: { type: "string", maxLength: 2000 }
      }
    }
    const output = { type: "object", required: ["path"], properties: { path: { type: "string" } } }
    expect(simpleSchemaCompatible(output, input)).toBe(false)
    expect(simpleSchemaCompatible({ ...output, additionalProperties: true }, input)).toBe(false)
    expect(
      simpleSchemaCompatible({ ...output, additionalProperties: { type: "number" } }, input)
    ).toBe(false)
    expect(simpleSchemaCompatible({ ...output, additionalProperties: false }, input)).toBe(true)
  })
  it("retains saved flow checkpoint after profile failure and resumes without a second flow", async () => {
    const saved: SavedFlow = { definition: definition(), revision: 1, digest: "d", updatedAt: 1 }
    const saveFlow = vi.fn(async () => saved)
    const saveProfile = vi
      .fn()
      .mockRejectedValueOnce(Error("binding changed"))
      .mockResolvedValueOnce(undefined)
    let checkpoint: SimpleSaveCheckpoint | undefined
    const run = () =>
      saveSimpleCombination({
        profile,
        definition: definition(),
        checkpoint,
        assertCurrent: () => {},
        onCheckpoint: (next) => {
          checkpoint = next
        },
        saveFlow,
        saveProfile
      })
    await expect(run()).rejects.toThrow("binding changed")
    expect(checkpoint?.flow).toBe(saved)
    const result = await run()
    expect(saveFlow).toHaveBeenCalledTimes(1)
    expect(saveProfile).toHaveBeenCalledTimes(2)
    expect(result.models).toEqual(profile.models)
    expect(result.skills).toEqual(profile.skills)
    expect(result.flow).toBe(saved)
    expect(checkpoint?.profileSaved).toBe(true)
  })
  it("stops before saving a profile after the user changes scope during flow save", async () => {
    let current = true
    const saveProfile = vi.fn()
    await expect(
      saveSimpleCombination({
        profile,
        definition: definition(),
        assertCurrent: () => {
          if (!current) throw Error("scope changed")
        },
        onCheckpoint: () => {},
        saveProfile,
        saveFlow: async (value) => {
          current = false
          return { definition: value, revision: 1, digest: "d", updatedAt: 1 }
        }
      })
    ).rejects.toThrow("scope changed")
    expect(saveProfile).not.toHaveBeenCalled()
  })
  it("leaves existing routed or saved flow objects to the full editor", () => {
    expect(simpleProfileSupported(profile)).toBe(true)
    expect(
      simpleProfileSupported({
        ...profile,
        flow: { definition: definition(), revision: 1, digest: "d", updatedAt: 1 }
      })
    ).toBe(false)
  })
})

describe("practice handoff", () => {
  it("carries only human text and a scoped, unique intent into the real source picker", () => {
    const first = createPracticeIntent("create", { threadId: "one", workspace: "C:/project" })
    const second = createPracticeIntent("create", first.scope)
    expect(first.target).toBe("new-component")
    expect(first.suggestedName).toBe("我的编辑提醒")
    expect(first.id).not.toBe(second.id)
    expect(first).not.toHaveProperty("pluginId")
    expect(
      sameSimpleAuthoringScope(first.scope, { threadId: "two", workspace: "C:/project" })
    ).toBe(false)
    expect(sameSimpleAuthoringScope(first.scope, { threadId: "one", workspace: "C:/other" })).toBe(
      false
    )
  })
})


describe("Windows first-task workspace handoff", () => {
  it("accepts the host canonical path and rejects a different project or thread", () => {
    vi.stubGlobal("window", { electron: { process: { platform: "win32" } } })
    try {
      const scope = { threadId: "one", workspace: "c:/users/person/project" }
      expect(sameSimpleAuthoringScope(scope, {
        threadId: "one", workspace: "C:\\Users\\Person\\Project\\"
      })).toBe(true)
      expect(sameSimpleAuthoringScope(scope, {
        threadId: "two", workspace: "C:/Users/Person/Project"
      })).toBe(false)
      expect(sameSimpleAuthoringScope(scope, {
        threadId: "one", workspace: "C:/Users/Person/Other"
      })).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })
  it("does not collapse case-sensitive platform project identities", () => {
    vi.stubGlobal("window", { electron: { process: { platform: "linux" } } })
    try {
      expect(sameSimpleAuthoringScope(
        { threadId: "one", workspace: "/home/Project" },
        { threadId: "one", workspace: "/home/project" }
      )).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })
})
