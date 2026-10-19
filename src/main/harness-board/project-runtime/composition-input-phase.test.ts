import { afterEach, describe, expect, it } from "vitest"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ProjectCompositionDefinition } from "../../../shared/project-runtime/composition"
import type { CompositionExecutionContext } from "./composition-coordinator"
import { ProjectCompositionStore } from "./composition-store"
import { CompositionWorkspaces } from "./composition-workspaces"
import { runtimeDigest } from "./safe-files"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "composition-input-phase-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new ProjectCompositionStore(join(root, "composition.sqlite"))
  cleanups.push(() => store.close())
  const source = { pluginId: "documents", capabilityId: "delivery", packageDigest: "a".repeat(64) }
  const definition: ProjectCompositionDefinition = {
    apiVersion: "devclaw.project-composition/v1",
    parentProjectId: "parent",
    workspace: root,
    units: [
      {
        id: "producer",
        kind: "flow",
        source,
        inputs: [],
        outputs: [{ id: "document", path: "result.json" }]
      },
      {
        id: "consumer",
        kind: "flow",
        source,
        inputs: [{ inputId: "input", fromUnitId: "producer", artifactId: "document" }],
        outputs: []
      }
    ]
  }
  const run = store.create(definition, "request", true).run
  const workspaces = new CompositionWorkspaces(
    join(root, "units"),
    store,
    () => "inputs/result.json"
  )
  const producer = workspaces.allocate(run.id, "producer")
  const consumer = workspaces.allocate(run.id, "consumer")
  const bytes = Buffer.from('{"verified":true}')
  writeFileSync(join(producer, "result.json"), bytes)
  const context: CompositionExecutionContext = {
    runId: run.id,
    parentProjectId: "parent",
    workspace: root,
    unit: definition.units[1],
    attemptId: "attempt",
    idempotencyKey: "key",
    inputs: [
      {
        inputId: "input",
        fromUnitId: "producer",
        source,
        artifact: { id: "document", path: "result.json", digest: runtimeDigest(bytes) }
      }
    ]
  }
  return { root, workspaces, producer, consumer, bytes, context }
}

describe("composition input verification lifecycle", () => {
  it("allows only initial missing materialization, then requires the original exact copied bytes", () => {
    const f = fixture()
    const destination = join(f.consumer, "inputs/result.json")
    expect(existsSync(destination)).toBe(false)
    expect(f.workspaces.verifyInputs(f.context, "before-prepare")).toBe(true)
    expect(f.workspaces.verifyInputs(f.context)).toBe(false)
    expect(() => f.workspaces.assertInputsCurrent(f.context)).toThrow("COMPOSITION_INPUTS_CHANGED")
    const prepared = f.workspaces.prepare(f.context)
    expect(prepared.executionWorkspace).toBe(f.consumer)
    expect(readFileSync(destination)).toEqual(f.bytes)
    expect(f.workspaces.verifyInputs(prepared)).toBe(true)
    f.workspaces.assertInputsCurrent(prepared)
    rmSync(destination)
    expect(f.workspaces.verifyInputs(prepared, "prepared")).toBe(false)
    expect(() => f.workspaces.assertInputsCurrent(prepared)).toThrow("COMPOSITION_INPUTS_CHANGED")
  })

  it("freshly rejects changed or missing producer bytes even when the consumer has no copy", () => {
    const f = fixture()
    writeFileSync(join(f.producer, "result.json"), "changed")
    expect(f.workspaces.verifyInputs(f.context, "before-prepare")).toBe(false)
    expect(() => f.workspaces.prepare(f.context)).toThrow("COMPOSITION_INPUTS_CHANGED")
    rmSync(join(f.producer, "result.json"))
    expect(f.workspaces.verifyInputs(f.context, "before-prepare")).toBe(false)
    expect(existsSync(join(f.consumer, "inputs/result.json"))).toBe(false)
  })

  it("does not reuse an earlier producer validation across preparation or later effects", () => {
    const f = fixture()
    expect(f.workspaces.verifyInputs(f.context, "before-prepare")).toBe(true)
    writeFileSync(join(f.producer, "result.json"), "changed after preflight")
    expect(() => f.workspaces.prepare(f.context)).toThrow("COMPOSITION_INPUTS_CHANGED")
    expect(existsSync(join(f.consumer, "inputs/result.json"))).toBe(false)
    writeFileSync(join(f.producer, "result.json"), f.bytes)
    const prepared = f.workspaces.prepare(f.context)
    expect(f.workspaces.verifyInputs(prepared, "before-prepare")).toBe(true)
    writeFileSync(join(f.producer, "result.json"), "changed after materialization")
    expect(() => f.workspaces.assertInputsCurrent(prepared)).toThrow("COMPOSITION_INPUTS_CHANGED")
    expect(readFileSync(join(f.consumer, "inputs/result.json"))).toEqual(f.bytes)
  })

  it.each(["changed", ""])(
    "rejects an existing conflicting copy (%j) before preparation",
    (value) => {
      const f = fixture()
      mkdirSync(join(f.consumer, "inputs"))
      writeFileSync(join(f.consumer, "inputs/result.json"), value)
      expect(f.workspaces.verifyInputs(f.context, "before-prepare")).toBe(false)
      expect(() => f.workspaces.prepare(f.context)).toThrow("COMPOSITION_INPUT_PATH_CONFLICT")
      expect(readFileSync(join(f.consumer, "inputs/result.json"), "utf8")).toBe(value)
    }
  )

  it("retains declared-output rewriting only after materialization, never for a prior conflict", () => {
    const f = fixture()
    f.context.unit.outputs = [{ id: "revised", path: "inputs/result.json" }]
    f.workspaces.prepare(f.context)
    writeFileSync(join(f.consumer, "inputs/result.json"), "legitimate subsequent revision")
    expect(f.workspaces.verifyInputs(f.context, "prepared")).toBe(true)
    expect(f.workspaces.verifyInputs(f.context, "before-prepare")).toBe(false)
    expect(() => f.workspaces.prepare(f.context)).toThrow("COMPOSITION_INPUT_PATH_CONFLICT")
  })

  it("rejects an actual symlink or junction parent instead of treating it as a missing copy", () => {
    const f = fixture()
    const outside = join(f.root, "outside")
    mkdirSync(outside)
    symlinkSync(
      outside,
      join(f.consumer, "inputs"),
      process.platform === "win32" ? "junction" : "dir"
    )
    expect(() => f.workspaces.verifyInputs(f.context, "before-prepare")).toThrow(
      "FILE_SCOPE_CHANGED"
    )
    expect(() => f.workspaces.prepare(f.context)).toThrow("FILE_SCOPE_CHANGED")
    expect(existsSync(join(outside, "result.json"))).toBe(false)
  })
})
