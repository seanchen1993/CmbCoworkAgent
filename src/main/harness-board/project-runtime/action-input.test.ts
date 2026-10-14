import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import {
  PROJECT_ACTION_LOCK_PATH,
  parseProjectActionLock,
  type ProjectActionLock
} from "../../../shared/project-runtime/action-bindings"
import type { HostProjectState } from "../../../shared/project-runtime/host-types"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import {
  assertProjectActionProviders,
  captureProjectActionInputs,
  createProjectActionBinding,
  readProjectActionLock
} from "./action-input"
import { createProjectActionFlow } from "./action-flow"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const descriptor: ClawActionDescriptor = {
  pluginId: "real-installed-fixture",
  plugin: "format-provider",
  digest: "e".repeat(64),
  actionId: "format",
  name: "Format",
  command: "format",
  inputSchema: {
    type: "object",
    required: ["text"],
    additionalProperties: false,
    properties: { text: { type: "string", minLength: 1 } }
  },
  outputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "project-actions-"))
  roots.push(root)
  const state: HostProjectState = {
    ...hostProjectFixture(root),
    schemaVersion: 1,
    stateOwner: "host",
    version: 2,
    stageIndex: 1,
    status: "active",
    createdAt: 1,
    updatedAt: 1
  }
  state.manifest.artifacts[0].path = "input.json"
  const first = createProjectActionBinding(
    "format",
    descriptor,
    {},
    {},
    { kind: "artifact", artifactId: "document", pointer: "/payload" }
  )
  const second = createProjectActionBinding(
    "reuse",
    descriptor,
    {},
    {},
    { kind: "action", actionId: "format", pointer: "" }
  )
  const lock: ProjectActionLock = {
    apiVersion: "devclaw.project-actions-lock/v1",
    bindings: [first, second]
  }
  state.manifest.actions = lock.bindings.map((item) => ({ id: item.id, ref: item.ref }))
  state.manifest.stages[1].actionIds = ["format", "reuse"]
  writeFileSync(join(root, "input.json"), JSON.stringify({ payload: { text: "actual input" } }))
  writeFileSync(join(root, PROJECT_ACTION_LOCK_PATH), JSON.stringify(lock))
  return { root, state, lock }
}
describe("host project public action mapping", () => {
  it("reads pinned lock and actual artifact object, preserving output mapping for native Flow", () => {
    const { root, state } = fixture()
    const lock = readProjectActionLock(root, state.manifest)
    expect(() => assertProjectActionProviders(lock, [descriptor])).not.toThrow()
    const captured = captureProjectActionInputs(state, lock)
    const flow = createProjectActionFlow(state, "operation", captured)
    expect(flow.schemaVersion).toBe(2)
    expect(flow.steps[0]).toMatchObject({
      kind: "plugin-action",
      input: { text: "actual input" },
      pluginId: descriptor.pluginId,
      digest: descriptor.digest
    })
    expect(flow.steps[1]).toMatchObject({ inputFrom: { stepId: "format", path: "" } })
    expect(flow.steps.some((step) => step.kind === "agent" || step.kind === "skill")).toBe(false)
  })
  it("checks identity, command and schemas against the real host catalogue", () => {
    const { lock } = fixture()
    for (const changed of [
      { ...descriptor, digest: "f".repeat(64) },
      { ...descriptor, command: "other" },
      { ...descriptor, inputSchema: { type: "object" } }
    ])
      expect(() => assertProjectActionProviders(lock, [changed])).toThrow(
        "PROJECT_ACTION_PROVIDER_CHANGED"
      )
    expect(() => assertProjectActionProviders(lock, [])).toThrow("PROJECT_ACTION_PROVIDER_CHANGED")
  })
  it("rejects changed approved input and cross-project reuse before Flow construction", () => {
    const { root, state, lock } = fixture()
    const captured = captureProjectActionInputs(state, lock)
    expect(() => createProjectActionFlow({ ...state, projectId: "other" }, "op", captured)).toThrow(
      "PROJECT_ACTION_SCOPE_CHANGED"
    )
    writeFileSync(join(root, "input.json"), JSON.stringify({ payload: { text: "changed" } }))
    expect(() => captured.assertCurrent()).toThrow("PROJECT_ACTION_INPUT_CHANGED")
  })
  it("uses constants as explicit overrides and validates final object against provider schema", () => {
    const { root, state, lock } = fixture()
    lock.bindings[0].input = { text: "explicit constant" }
    expect(captureProjectActionInputs(state, lock).bindings[0].input).toEqual({
      text: "explicit constant"
    })
    lock.bindings[0].input = {}
    writeFileSync(join(root, "input.json"), JSON.stringify({ payload: { wrong: true } }))
    expect(() => captureProjectActionInputs(state, lock)).toThrow()
  })
  it("rejects mutation of an already captured action input", () => {
    const { state, lock } = fixture()
    const captured = captureProjectActionInputs(state, lock)
    captured.bindings[0].input.text = "changed after preparation"
    expect(() => createProjectActionFlow(state, "operation", captured)).toThrow(
      "PROJECT_ACTION_INPUT_CHANGED"
    )
  })
  it("rejects current-stage inputs, forward output references and unsafe pointers", () => {
    const { state, lock } = fixture()
    state.manifest.stages[0].artifactIds = []
    expect(() => captureProjectActionInputs(state, lock)).toThrow("PROJECT_ACTION_INPUT_NOT_PRIOR")
    lock.bindings[0].inputFrom = { kind: "action", actionId: "reuse", pointer: "" }
    expect(() => captureProjectActionInputs(state, lock)).toThrow("PROJECT_ACTION_OUTPUT_ORDER")
    lock.bindings[0].inputFrom = { kind: "artifact", artifactId: "document", pointer: "/__proto__" }
    expect(() => parseProjectActionLock(lock)).toThrow("CLAW_ACTION_POINTER_INVALID")
  })
  it("rejects sensitive paths without reading them and bounds artifact bytes", () => {
    const { root, state, lock } = fixture()
    state.manifest.artifacts[0].path = ".env"
    expect(() => captureProjectActionInputs(state, lock)).toThrow("PROJECT_ACTION_INPUT_FORBIDDEN")
    state.manifest.artifacts[0].path = "input.json"
    writeFileSync(
      join(root, "input.json"),
      JSON.stringify({ payload: { text: "x".repeat(28_000) } })
    )
    expect(() => captureProjectActionInputs(state, lock)).toThrow("FILE_LIMIT")
  })
  it("rejects missing/extra lock identities and unsupported schema before execution", () => {
    const { root, state, lock } = fixture()
    state.manifest.actions.pop()
    expect(() => readProjectActionLock(root, state.manifest)).toThrow(
      "PROJECT_ACTION_LOCK_MISMATCH"
    )
    expect(() =>
      createProjectActionBinding(
        "bad",
        {
          ...descriptor,
          inputSchema: { type: "object", properties: { text: { type: "string", pattern: "x" } } }
        },
        {}
      )
    ).toThrow()
    expect(() => parseProjectActionLock({ ...lock, grant: true })).toThrow(
      "PROJECT_ACTION_LOCK_INVALID"
    )
  })
})
