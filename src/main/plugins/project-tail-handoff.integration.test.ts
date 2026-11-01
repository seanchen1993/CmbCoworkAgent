import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterAll, afterEach, expect, it, vi } from "vitest"
import type {
  HostProjectOperation,
  HostProjectState
} from "../../shared/project-runtime/host-types"
import { HostProjectService } from "../harness-board/project-runtime/host-service"
import { HostProjectStore } from "../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { readHostPackageSkill } from "../harness-board/project-runtime/package-skill-content"
import {
  captureProjectActionInputs,
  readProjectActionLock
} from "../harness-board/project-runtime/action-input"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { readProjectSource } from "../mods/devtools/project-source"
import {
  compileNativeComposition,
  nativeCompositionSchema,
  readNativeCompositionFiles
} from "./native-composition"

// Deliberate test seam: business execution/check results are controlled. Host, SQLite,
// package snapshots, artifact fingerprints, result approval and transitions are real.
// No failed live run, business validator, or delivered plugin is modified by this suite.
const boundary = vi.hoisted(() => ({
  results: new Map<string, { result: "passed" | "failed" }>()
}))
vi.mock("../harness-board/project-runtime/action-check-evidence", async (original) => {
  const actual =
    await original<typeof import("../harness-board/project-runtime/action-check-evidence")>()
  return {
    ...actual,
    readHostActionCheckEvidence: (
      project: HostProjectState,
      _ticket: unknown,
      operation: HostProjectOperation,
      _root: string,
      only?: readonly string[]
    ) => {
      const checks = project.manifest.checks.filter(
        (check) =>
          check.kind === "action" &&
          project.manifest.stages[project.stageIndex].checkIds.includes(check.id) &&
          (!only || only.includes(check.id))
      )
      if (!checks.length) return new Map()
      const value = boundary.results.get(operation.operationId)
      if (!value) throw Error("CONTROLLED_RESULT_NOT_EXECUTED")
      return new Map(
        checks.map((check) => [
          check.id,
          {
            result: value.result,
            validatorVersion: "controlled-stage-result/v1:" + operation.operationId
          }
        ])
      )
    }
  }
})

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const cleanup: Array<() => void> = []
const reports: unknown[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
  boundary.results.clear()
})
afterAll(() => {
  if (!process.env.PROJECT_HANDOFF_REPORT) return
  const path = resolve(process.env.PROJECT_HANDOFF_REPORT)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      {
        scope: "controlled-stage-boundary-integration",
        businessExecutionVerified: false,
        productionCodeChanged: false,
        controlledSeams: [
          "stage body",
          "business action result",
          "authorization",
          "configuration identity"
        ],
        environmentIssuesExcluded: ["Git identity", "native approval wall-clock timeout"],
        expectedCaseCount: variants.length,
        passed: reports.length === variants.length,
        cases: reports
      },
      null,
      2
    )
  )
})

interface FixtureSchema {
  const?: unknown
  enum?: unknown[]
  type?: string
  required?: string[]
  properties?: Record<string, FixtureSchema>
  minItems?: number
  items?: FixtureSchema
  minimum?: number
}
function schemaValue(schema: FixtureSchema): unknown {
  if (Object.hasOwn(schema, "const")) return schema.const
  if (schema.enum) return schema.enum[0]
  if (schema.type === "object")
    return Object.fromEntries(
      (schema.required ?? []).map((key: string) => [
        key,
        schemaValue(schema.properties?.[key] ?? { type: "string" })
      ])
    )
  if (schema.type === "array")
    return Array.from({ length: Math.max(1, schema.minItems ?? 0) }, () =>
      schemaValue(schema.items ?? { type: "string" })
    )
  if (schema.type === "number" || schema.type === "integer") return schema.minimum ?? 1
  if (schema.type === "boolean") return true
  return "controlled handoff fixture"
}

const base = resolve("resources/native-compositions/autobiz-lean/project")
const variants = [
  { name: "current-autobiz-five", root: base, append: false },
  { name: "current-autobiz-appended-audit", root: base, append: true },
  {
    name: "non-autobiz-vendor",
    root: resolve("tests/fixtures/native-compositions/vendor"),
    append: false
  },
  ...(process.env.PROJECT_HANDOFF_DERIVED_SOURCE
    ? [
        {
          name: "saved-model-derived-six",
          root: resolve(process.env.PROJECT_HANDOFF_DERIVED_SOURCE),
          append: false
        }
      ]
    : [])
]

it.each(variants)(
  "completes real Host handoffs for $name with controlled stage results",
  async (variant) => {
    const source = nativeCompositionSchema.parse(
      JSON.parse(readFileSync(join(variant.root, "composition/source.json"), "utf8"))
    )
    const sourceDigest = (await readProjectSource(variant.root)).bundle.digest
    if (variant.name === "saved-model-derived-six") {
      expect(process.env.PROJECT_HANDOFF_DERIVED_DIGEST).toMatch(/^[a-f0-9]{64}$/)
      expect(sourceDigest).toBe(process.env.PROJECT_HANDOFF_DERIVED_DIGEST)
    }
    const files = readNativeCompositionFiles(variant.root, source)
    if (variant.append) {
      const previous = source.modules.at(-1)!.outputs[0]
      source.modules.push({
        id: "audit",
        version: "1.0.0",
        title: "Independent audit",
        skill: "modules/handoff-audit/SKILL.md",
        inputs: [{ artifactId: previous.id, contract: previous.contract }],
        contextArtifactIds: [previous.id],
        outputs: [{ id: "audit", path: "audit.json", contract: "audit/v1" }],
        checks: [
          {
            id: "audit.schema",
            kind: "json-schema",
            artifactId: "audit",
            schema: {
              type: "object",
              required: ["summary", "findings"],
              properties: {
                summary: { type: "string", minLength: 1 },
                findings: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }
              }
            }
          }
        ],
        approval: "none",
        resultApproval: "human"
      })
      if (source.contextAction?.config)
        source.contextAction.config.stageTags = {
          ...(source.contextAction.config.stageTags as Record<string, string[]>),
          audit: ["audit", "review", "delivery", "cicd", "archive"]
        }
      files.push({
        path: "modules/handoff-audit/SKILL.md",
        bytes: Buffer.from(
          "---\nname: handoff-audit\ndescription: Controlled audit handoff\n---\nRead the previous artifact and produce an audit result.\n"
        )
      })
    }
    const catalog = (
      await Promise.all(
        ["knowledge", "rules", "delivery"].map(async (name) => {
          const provider = await compileFunctionPlugin(
            resolve("resources/native-compositions/autobiz-lean/providers", name)
          )
          if (!provider?.actions) throw Error("PROVIDER_COMPILE_REQUIRED")
          return provider.actions.map(({ id, ...action }) => ({
            ...action,
            actionId: id,
            pluginId: "test-" + name,
            plugin: provider.name,
            digest: provider.digest
          }))
        })
      )
    ).flat()
    const compiled = compileNativeComposition(source, { files, actionCatalog: catalog })
    const root = mkdtempSync(join(tmpdir(), "project-handoff-"))
    cleanup.push(() => {
      const target = realpathSync(root)
      expect(dirname(target)).toBe(realpathSync(tmpdir()))
      expect(basename(target)).toMatch(/^project-handoff-[a-zA-Z0-9]{6}$/)
      rmSync(target, { recursive: true, force: true })
    })
    const workspace = join(root, "workspace")
    const installed = join(root, "installed")
    mkdirSync(workspace)
    for (const file of compiled.files) {
      const path = join(installed, file.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file.bytes)
    }
    const metadata = JSON.parse(readFileSync(join(installed, "plugin.json"), "utf8"))
    const database = join(root, "host.sqlite")
    let store = new HostProjectStore(database)
    cleanup.push(() => store.close())
    const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
    const approvedArtifacts = new Map<string, string>()
    const calls: string[] = []
    const observed: unknown[] = []
    let invalidOutput = false
    let controlledFailure = false
    const createHost = () =>
      new HostProjectService(store, snapshots, {
        resolveInstalledPlugin: async () => ({
          installedPluginId: "handoff-install",
          root: installed,
          packageId: metadata.name,
          packageVersion: metadata.version,
          enabled: true
        }),
        authorize: async () => {},
        prepareInputIdentity: async () => {},
        inputIdentity: () => "controlled-config:" + sourceDigest,
        captureInputAuthorityIdentity: () => () => "controlled-config:" + sourceDigest,
        executeSkill: async (context) => {
          const module = source.modules.find((item) => item.id === context.operation.stageId)!
          const stage = context.project.manifest.stages[context.project.stageIndex]
          const predecessors = source.modules
            .slice(0, context.project.stageIndex)
            .flatMap((item) => item.outputs)
          expect(stage.inputArtifactIds ?? predecessors.map((item) => item.id)).toEqual(
            module.inputs.map((item) => item.artifactId)
          )
          expect(stage.contextArtifactIds).toEqual(module.contextArtifactIds)
          expect(stage.artifactIds).toEqual(module.outputs.map((item) => item.id))
          const skill = readHostPackageSkill(context.snapshotRoot, context.skillPath).toString(
            "utf8"
          )
          const inputLine = skill
            .slice(skill.lastIndexOf("## Compiled stage contract"))
            .split("\n")
            .find((line) => line.startsWith("Inputs: "))
          expect(inputLine).toBeDefined()
          expect(JSON.parse(inputLine!.slice("Inputs: ".length))).toEqual(
            module.inputs
              .filter(
                (item) =>
                  module.contextArtifactIds === undefined ||
                  module.contextArtifactIds.includes(item.artifactId)
              )
              .map((item) => predecessors.find((output) => output.id === item.artifactId))
          )
          const inputs = [
            ...new Set([
              ...module.inputs.map((input) => input.artifactId),
              ...(module.contextArtifactIds ?? [])
            ])
          ]
          for (const id of inputs) {
            const artifact = context.project.manifest.artifacts.find((item) => item.id === id)!
            expect(hash(readFileSync(join(workspace, artifact.path)))).toBe(
              approvedArtifacts.get(id)
            )
          }
          calls.push(module.id)
          context.bindThread("controlled-" + context.operation.operationId)
          for (const output of module.outputs) {
            const schemaCheck = module.checks.find(
              (check) => check.kind === "json-schema" && check.artifactId === output.id
            )
            const schema = schemaCheck?.kind === "json-schema" ? schemaCheck.schema : undefined
            const value = schema
              ? schemaValue(schema)
              : {
                  controlledFixture: true,
                  stage: module.id,
                  feature: "handoff-only",
                  runId: "controlled-no-business-execution",
                  inputs: Object.fromEntries(inputs.map((id) => [id, approvedArtifacts.get(id)]))
                }
            const path = join(workspace, output.path)
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, invalidOutput ? "" : JSON.stringify(value))
          }
          // Exercise the original action input binding against actual current/upstream files.
          const checks = context.project.manifest.checks.filter(
            (check) => module.checks.some((item) => item.id === check.id) && check.kind === "action"
          )
          if (checks.length) {
            const lock = readProjectActionLock(context.snapshotRoot, context.project.manifest)
            const captured = captureProjectActionInputs(context.project, lock, {
              actionIds: checks.map((check) => check.actionId!),
              allowCheckArtifacts: true,
              readConfiguration: (keys) =>
                Object.fromEntries(
                  keys.map((key) => [
                    key,
                    key === "executionAdapter"
                      ? "node-test/v1"
                      : key === "knowledgeRoot"
                        ? workspace
                        : "[]"
                  ])
                )
            })
            captured.assertCurrent()
          }
          boundary.results.set(context.operation.operationId, {
            result: controlledFailure || invalidOutput ? "failed" : "passed"
          })
          observed.push({ stage: module.id, inputs, controlledFailure, invalidOutput })
          context.recordTerminal({ outcome: "success", code: "controlled-stage-body-complete" })
          return "succeeded"
        }
      })
    let host = createHost()
    await host.localCreate({
      projectId: "handoff",
      name: variant.name,
      workspace,
      installedPluginId: "handoff-install",
      goal: "Verify stage handoffs only; business work is deliberately controlled."
    })
    const run = async () => {
      const project = host.get("handoff")!
      const op = host.prepare({
        projectId: project.projectId,
        expectedVersion: project.version,
        idempotencyKey: randomUUID()
      })
      if (project.manifest.stages[project.stageIndex].approval === "human")
        host.approve(op.operationId, {
          expectedVersion: project.version,
          inputFingerprint: op.inputFingerprint,
          decision: "approved",
          actorId: "controlled-reviewer"
        })
      return host.start(op.operationId)
    }
    const transitions: unknown[] = []
    for (const [index, module] of source.modules.entries()) {
      // A failed boundary cannot be mistaken for an environment exclusion or skipped forward.
      if (index === source.modules.length - 1) {
        invalidOutput = true
        const failed = await run()
        expect(failed.status).toBe("failed")
        expect(() => host.transition(failed.operationId)).toThrow()
        expect(host.get("handoff")!.stageIndex).toBe(index)
        invalidOutput = false
      }
      if (module.id === "code") {
        controlledFailure = true
        const failed = await run()
        expect(failed.status).toBe("failed")
        expect(() => host.transition(failed.operationId)).toThrow()
        controlledFailure = false
      }
      const op = await run()
      expect(op.status, JSON.stringify(op)).toBe("succeeded")
      expect(op.receipts.every((receipt) => receipt.result === "passed")).toBe(true)
      const review = host.resultReview(op.operationId)
      if (module.resultApproval === "human") {
        expect(() => host.transition(op.operationId)).toThrow("RESULT_APPROVAL_REQUIRED")
        host.decideResultApproval(op.operationId, {
          ...review,
          decision: "approved",
          actorId: "controlled-reviewer"
        })
      }
      const output = module.outputs[0]
      const path = join(workspace, output.path)
      const original = readFileSync(path)
      writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]))
      expect(() => host.transition(op.operationId)).toThrow("EVIDENCE_STALE")
      expect(host.get("handoff")!.stageIndex).toBe(index)
      writeFileSync(path, original)
      host.transition(op.operationId)
      for (const item of module.outputs)
        approvedArtifacts.set(item.id, hash(readFileSync(join(workspace, item.path))))
      expect(host.get("handoff")!.stageIndex).toBe(index + 1)
      expect(host.get("handoff")!.version).toBe(index + 2)
      expect(
        host.operations("handoff").find((item) => item.operationId === op.operationId)!.status
      ).toBe("transitioned")
      const count = calls.length
      try {
        host.transition(op.operationId)
      } catch {
        /* Rejection or idempotent no-op is acceptable. */
      }
      expect(calls).toHaveLength(count)
      expect(host.get("handoff")!.version).toBe(index + 2)
      const next = source.modules[index + 1]?.id ?? "completed"
      transitions.push({ from: module.id, to: next, version: index + 2 })
      if (next !== "completed") {
        writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]))
        expect(() =>
          host.prepare({
            projectId: "handoff",
            expectedVersion: index + 2,
            idempotencyKey: "changed-input-" + module.id
          })
        ).toThrow()
        writeFileSync(path, original)
      }
      store.close()
      store = new HostProjectStore(database)
      host = createHost()
      expect(host.get("handoff")!.stageIndex).toBe(index + 1)
    }
    expect(host.get("handoff")!.status).toBe("completed")
    expect(host.get("handoff")!.stageIndex).toBe(source.modules.length)
    const count = calls.length
    expect(() =>
      host.prepare({
        projectId: "handoff",
        expectedVersion: source.modules.length + 1,
        idempotencyKey: "after-completed"
      })
    ).toThrow()
    expect(calls).toHaveLength(count)
    expect((await readProjectSource(variant.root)).bundle.digest).toBe(sourceDigest)
    reports.push({
      name: variant.name,
      sourceDigest,
      declarationDigest: hash(JSON.stringify(source)),
      compiledPackageDigest: host.get("handoff")!.pluginDigest,
      passed: true,
      transitions,
      observed,
      finalStatus: host.get("handoff")!.status,
      persistedAcrossReopen: true,
      negativeChecks: [
        "failed-output",
        "result-approval-required",
        "changed-result",
        "changed-upstream",
        "duplicate-transition",
        "completed-rejects-new-stage"
      ]
    })
  },
  60_000
)
