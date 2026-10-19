import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolveClawActionInput, type ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import type { ClawProfile } from "../../../shared/mods/claw"
import type { SavedFlow } from "../../../shared/mods/flows/types"
import {
  buildSimpleFlow,
  createSimpleClawDraft,
  updateSimpleClawProfile,
  simpleDraftDefinition,
  editSimpleFlowText,
  removeSimpleStep,
  markSimpleDraftSaved,
  saveSimpleCombination,
  simpleConnections,
  simpleFormSupported,
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
  it("proves bounded array handoffs and rejects wider item or collection constraints", () => {
    const array = { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 240 } }
    const schema = { type: "object", properties: { sourcePaths: array },
      required: ["sourcePaths"], additionalProperties: false }
    expect(simpleFormSupported(schema)).toBe(true)
    expect(simpleConnections(schema, schema)).toEqual([{ path: "", label: "完整输出" }])
    expect(simpleSchemaCompatible({ ...array, maxItems: 17 }, array)).toBe(false)
    expect(simpleSchemaCompatible({ ...array, items: { type: "number" } }, array)).toBe(false)
    expect(simpleSchemaCompatible(array, { ...array, uniqueItems: true })).toBe(false)
    expect(simpleSchemaCompatible({ ...array, items: { type: "string" } }, array)).toBe(false)
  })
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
  it("preserves explicit bound overrides and inherits upstream fields after the user clears them", () => {
    const schema = { type: "object", additionalProperties: false,
      required: ["path"], properties: { path: { type: "string" } } }
    const pathAction = { ...actions[0], inputSchema: schema, outputSchema: schema }
    const make = (input: Record<string, string>) => buildSimpleFlow({ id: "bound", name: "bound",
      actions: [pathAction, pathAction], inputs: [{ path: "src/producer.ts" }, input],
      configs: [{}, {}], bindings: [undefined, { stepId: "step-1", path: "" }] }).steps[1]
    const explicit = make({ path: "src/explicit.ts" })
    const inherited = make({})
    if (explicit.kind !== "plugin-action" || inherited.kind !== "plugin-action") throw Error("wrong fixture")
    expect(explicit.input).toEqual({ path: "src/explicit.ts" })
    expect(resolveClawActionInput(explicit.input, { path: "src/upstream.ts" }, explicit.inputFrom?.path)).toEqual({ path: "src/explicit.ts" })
    expect(inherited.inputFrom).toEqual(explicit.inputFrom)
    expect(resolveClawActionInput(inherited.input, { path: "src/upstream.ts" }, inherited.inputFrom?.path)).toEqual({ path: "src/upstream.ts" })
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
  it("allows ordinary saved plugin steps and retains routed flows in the advanced editor", () => {
    expect(simpleProfileSupported(profile)).toBe(true)
    expect(
      simpleProfileSupported({
        ...profile,
        flow: { definition: definition(), revision: 1, digest: "d", updatedAt: 1 }
      })
    ).toBe(true)
    const routed = definition()
    routed.steps[0].onSuccess = "step-2"
    expect(
      simpleProfileSupported({
        ...profile,
        flow: { definition: routed, revision: 1, digest: "d", updatedAt: 1 }
      })
    ).toBe(false)
  })
})

describe("one canonical editing document", () => {
  it("retains profile fields and incomplete parameters across profile-only view edits without saving", () => {
    const draft = createSimpleClawDraft(profile, "flow")
    draft.mode = "sequence"
    draft.steps = [
      {
        id: "s",
        action: "autobiz:prepare-review",
        input: { path: "src/cart.ts", feature: "REAL-1" },
        config: {}
      }
    ]
    draft.parameterDrafts["s:config"] = { numbers: { budget: "1e" }, dirty: true }
    const next = updateSimpleClawProfile(draft, { ...draft.profile, name: "高级名称" })
    expect(next.steps).toBe(draft.steps)
    expect(next.parameterDrafts["s:config"].numbers?.budget).toBe("1e")
    expect(next.profile.flow).toBeUndefined()
    expect(next.profile.models).toEqual(profile.models)
    expect(simpleDraftDefinition(next, actions)?.steps).toHaveLength(1)
  })
  it("supports one, two and more steps with explicit compatible prior bindings", () => {
    for (const count of [1, 2, 4]) {
      const selected = Array.from({ length: count }, (_, index) => actions[index ? 1 : 0])
      const flow = buildSimpleFlow({
        id: "many",
        name: "many",
        actions: selected,
        inputs: selected.map(() => ({})),
        configs: selected.map(() => ({})),
        bindings: selected.map((_, index) => (index ? { stepId: "step-1", path: "" } : undefined))
      })
      expect(flow.steps).toHaveLength(count)
      expect(flow.maxExecutions).toBe(count)
    }
    expect(() =>
      buildSimpleFlow({
        id: "bad",
        name: "bad",
        actions,
        inputs: [{}, {}],
        configs: [{}, {}],
        bindings: [{ stepId: "step-2", path: "" }, undefined]
      })
    ).toThrow("前置")
    expect(() =>
      buildSimpleFlow({
        id: "bad",
        name: "bad",
        actions,
        inputs: [{}, {}],
        configs: [{}, {}],
        bindings: [undefined, { stepId: "step-1", path: "/missing" }]
      })
    ).toThrow("兼容")
  })
  it("removes only the deleted step drafts and invalidates downstream references", () => {
    const draft = createSimpleClawDraft(profile, "f")
    draft.steps = [
      { id: "first", action: "a", input: {}, config: {} },
      {
        id: "second",
        action: "b",
        input: {},
        config: {},
        inputFrom: { stepId: "first", path: "" }
      },
      { id: "third", action: "b", input: {}, config: {} }
    ]
    draft.parameterDrafts = {
      "first:input": { dirty: true },
      "third:input": { json: "{", dirty: true }
    }
    const next = removeSimpleStep(draft, "first")
    expect(next.steps[0].inputFrom).toBeUndefined()
    expect(next.parameterDrafts).toEqual({ "third:input": { json: "{", dirty: true } })
  })
  it("preserves advanced routing and exact receipt while editing an unsaved definition", () => {
    const flow = definition()
    flow.steps[0].onSuccess = "step-2"
    const receipt = { definition: flow, revision: 7, digest: "host-proof", updatedAt: 1 }
    const draft = createSimpleClawDraft({ ...profile, flow: receipt }, "unused")
    const changed = { ...flow, goal: "新目标", timeoutMs: 345000 }
    const next = editSimpleFlowText(draft, JSON.stringify(changed))
    expect(next.profile.flow).toEqual(receipt)
    expect(simpleDraftDefinition(next, actions)).toEqual(changed)
    expect(next.profile.flow?.revision).toBe(7)
    const invalid = editSimpleFlowText(next, '{"steps":')
    expect(invalid.flowText).toBe('{"steps":')
    expect(invalid.baseDefinition).toEqual(changed)
    expect(() => simpleDraftDefinition(invalid, actions)).toThrow()
  })
  it("keeps the host flow revision when together mode temporarily detaches its saved flow", () => {
    const receipt: SavedFlow = {
      definition: definition(),
      revision: 8,
      digest: "real-host",
      updatedAt: 1
    }
    const draft = createSimpleClawDraft({ ...profile, flow: receipt }, "unused")
    const detached = markSimpleDraftSaved(
      { ...draft, mode: "together" },
      { ...profile, flow: undefined }
    )
    expect(detached.profile.flow).toBeUndefined()
    expect(detached.savedFlow).toBe(receipt)
    const resumed = { ...detached, mode: "sequence" as const }
    expect(simpleDraftDefinition(resumed, actions)?.id).toBe(receipt.definition.id)
    expect(resumed.savedFlow?.revision).toBe(8)
  })
  it("retains invalid advanced text without publishing malformed step structures", () => {
    const draft = createSimpleClawDraft(profile, "flow")
    for (const steps of [
      [null],
      [{ kind: "plugin-action", id: "s", name: "s", enabled: true, input: null }]
    ]) {
      const next = editSimpleFlowText(draft, JSON.stringify({ ...definition(), steps }))
      expect(next.flowTextError).toBeTruthy()
      expect(next.profile.flow).toBeUndefined()
      expect(next.steps).toEqual(draft.steps)
    }
  })
  it("does not silently upgrade a saved action identity when the catalog source changed", () => {
    const draft = createSimpleClawDraft(
      {
        ...profile,
        flow: { definition: definition(), revision: 2, digest: "proof", updatedAt: 1 }
      },
      "unused"
    )
    expect(() =>
      simpleDraftDefinition(
        draft,
        actions.map((action) => ({ ...action, digest: "b".repeat(64) }))
      )
    ).toThrow("请选择")
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
      expect(
        sameSimpleAuthoringScope(scope, {
          threadId: "one",
          workspace: "C:\\Users\\Person\\Project\\"
        })
      ).toBe(true)
      expect(
        sameSimpleAuthoringScope(scope, {
          threadId: "two",
          workspace: "C:/Users/Person/Project"
        })
      ).toBe(false)
      expect(
        sameSimpleAuthoringScope(scope, {
          threadId: "one",
          workspace: "C:/Users/Person/Other"
        })
      ).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("does not collapse case-sensitive platform project identities", () => {
    vi.stubGlobal("window", { electron: { process: { platform: "linux" } } })
    try {
      expect(
        sameSimpleAuthoringScope(
          { threadId: "one", workspace: "/home/Project" },
          { threadId: "one", workspace: "/home/project" }
        )
      ).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
