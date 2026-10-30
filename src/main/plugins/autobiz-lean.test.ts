import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { spawnSync } from "node:child_process"
import { runInNewContext } from "node:vm"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"
import {
  compileNativeComposition,
  nativeCompositionSchema,
  readNativeCompositionFiles
} from "./native-composition"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { createAuthoringSourceBundle } from "../mods/devtools/authoring-bundle"
import { inspectProjectSource } from "../mods/devtools/project-doctor"
import { testProjectSource } from "../mods/devtools/project-contract"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import { businessInput } from "./autobiz-native-fixture.test-helper"
import { baselineFixture, baselineDefinitionFields } from "./autobiz-lean-baseline.test-helper"
import { captureProjectArtifactReference } from "../harness-board/project-runtime/artifact-reference"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import { readProjectSourceSet } from "../mods/devtools/project-source-set"
import { selectStageKnowledge } from "../../../resources/native-compositions/autobiz-lean/providers/knowledge/mods/stage-selection"

const sourceSetRoot = resolve("resources/native-compositions/autobiz-lean")
const root = join(sourceSetRoot, "project")
const oldRoot = resolve("resources/native-compositions/autobiz")
const rulesRoot = resolve("resources/native-compositions/autobiz-rules")
const knowledgeRoot = join(sourceSetRoot, "providers/knowledge")
const oldKnowledgeRoot = resolve("resources/native-compositions/autobiz-knowledge")
const sourceAt = (path = root) =>
  nativeCompositionSchema.parse(
    JSON.parse(readFileSync(join(path, "composition/source.json"), "utf8"))
  )
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex")
function runHelper(workspace: string, name: string, input?: unknown) {
  const result = spawnSync("python", ["-I", "-B", "-X", "utf8", join(root, "tools", name)], {
    cwd: workspace,
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8"
  })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}
const selected = [{ deployUnitId: "orders", appType: "backend" as const }]
const documents = [
  { path: "AGENTS.md", text: "所有阶段保留权限与数据完整性规则。" },
  {
    path: "orders.md",
    text: "---\ntype: Service Knowledge\ndeploy_unit: orders\n---\n订单业务通用约束。"
  },
  {
    path: "design.md",
    text:
      "---\ntype: Reference\ndeploy_unit: orders\nautobiz_stages: [design, plan, code]\n---\n" +
      "数据库设计约束。".repeat(50)
  }
]

async function provider(path: string, installation: string) {
  const value = await compileFunctionPlugin(path)
  if (!value?.actions) throw Error("REAL_PROVIDER_COMPILE_REQUIRED")
  return value.actions.map(({ id, ...action }) => ({
    ...action,
    actionId: id,
    pluginId: installation,
    plugin: value.name,
    digest: value.digest
  }))
}

// Runs the actual source callback with the public SDK surface, not an imitation of its selection.
async function handler(path: string, capability = "knowledge") {
  const bundle = await build({
    entryPoints: [join(path, "mods/main.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs"
  })
  const module = { exports: {} as { register: (on: unknown) => void } }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports })
  let act: (
    sdk: unknown,
    event: unknown
  ) => Promise<{
    status: string
    text: string
    output: { passed: boolean; selectedPaths?: string[] }
  }>
  module.exports.register({
    capability: (definition: { id: string }, callbacks: { act: typeof act }) => {
      if (definition.id === capability) act = callbacks.act
    }
  })
  return act!
}

async function context(path: string, packageRoot: string, stageId: string) {
  const act = await handler(path)
  let operations = 0
  let snapshotReads = 0
  const response = await act(
    {
      platform: {
        read: async () => {
          snapshotReads++
          return {
            value: {
              stageId,
              configuration: {
                selectedDeployUnits: JSON.stringify(selected)
              },
              roots: [{ id: "knowledge" }, { id: "package" }]
            }
          }
        },
        act: async ({
          action,
          input
        }: {
          action: string
          input: { rootId: string; path: string }
        }) => {
          operations++
          if (action === "list")
            return {
              status: "succeeded",
              value: {
                entries: documents.map((document) => ({ kind: "file", path: document.path })),
                nextOffset: null
              }
            }
          const text =
            input.rootId === "package"
              ? readFileSync(join(packageRoot, "knowledge", input.path), "utf8")
              : documents.find((document) => document.path === input.path)!.text
          return { status: "succeeded", value: { path: input.path, text, digest: sha(text) } }
        }
      }
    },
    {
      input: {
        executionId: "actual-source-callback",
        config: path === oldKnowledgeRoot ? {} : sourceAt().contextAction!.config
      }
    }
  )
  return { ...response, operations, snapshotReads }
}

function leanFixture() {
  const old = businessInput()
  const baseline = baselineFixture(old.normalized.feature, old.normalized.requirements, "fixture")
  const definition = {
    feature: old.normalized.feature,
    ...baselineDefinitionFields(baseline, {
      "order-query": old.specs.files["specs/order-query/spec.md"]
    }),
    requirements: old.normalized.requirements,
    prd: old.prd.files["PRD.md"].replace(
      "来源：NORMALIZED_REQUIREMENTS.json",
      "来源：Definition.json.requirements"
    ),
    scope: JSON.parse(old.prd.files["IMPLEMENTATION_SCOPE.json"]),
    ui: JSON.parse(old.specs.files["UI_CONTEXT.json"]),
    proposal: old.specs.files["proposal.md"],
    specs: { "order-query": old.specs.files["specs/order-query/spec.md"] }
  }
  const solution = {
    feature: definition.feature,
    design: old.design.files["design.md"],
    designLock: JSON.parse(old.design.files[".design-contract.lock.json"]),
    plan: JSON.parse(old.plan.files["plan.json"]),
    batches: Object.fromEntries(
      Object.entries(old.plan.files)
        .filter(([path]) => path.startsWith("plans/"))
        .map(([path, text]) => [path.split("/")[1], JSON.parse(text as string)])
    )
  }
  return { baseline, definition, solution }
}

const leanRulesRoot = join(sourceSetRoot, "providers/rules")
const deliveryRoot = join(sourceSetRoot, "providers/delivery")
async function catalog() {
  return [
    ...(await provider(leanRulesRoot, "rules")),
    ...(await provider(knowledgeRoot, "knowledge")),
    ...(await provider(deliveryRoot, "delivery"))
  ]
}

function reference(workspace: string, stage: "baseline" | "definition" | "solution" | "delivery") {
  const paths = {
    baseline: ["RequestBaseline.json"],
    definition: ["RequestBaseline.json", "Definition.json"],
    solution: ["RequestBaseline.json", "Definition.json", "Solution.json"],
    delivery: [
      "RequestBaseline.json",
      "Definition.json",
      "Solution.json",
      "Code.json",
      "Delivery.json"
    ]
  }[stage]
  const rows = paths.map((path) => {
    const bytes = readFileSync(join(workspace, path))
    return {
      artifactId: path === "RequestBaseline.json" ? "baseline" : path.split(".")[0].toLowerCase(),
      path,
      bytes: bytes.length,
      sha256: sha(bytes),
      maxBytes: path === "Delivery.json" ? 524288 : path === "Code.json" ? 28000 : 131072
    }
  })
  return {
    protocol: "devclaw.artifact-input/v1",
    projectId: "fixture",
    stageId: stage,
    version: 1,
    pluginDigest: "a".repeat(64),
    workspaceIdentity: "b".repeat(64),
    current: rows.at(-1),
    sources: rows.slice(0, -1),
    requestProvenance: (() => {
      const request = leanFixture().baseline.request
      return {
        protocol: request.protocol,
        projectId: request.projectId,
        bytes: request.bytes,
        sha256: request.sha256
      }
    })()
  }
}

describe("AutoBiz baseline and five-stage native author source", () => {
  it("compiles the standalone knowledge and pure business capabilities with real code identities", async () => {
    const actions = [
      ...(await provider(leanRulesRoot, "rules")),
      ...(await provider(knowledgeRoot, "knowledge"))
    ]
    expect(actions.map((action) => action.actionId).sort()).toEqual([
      "baseline.verify",
      "context",
      "definition.verify",
      "delivery.documents",
      "solution.inspect",
      "solution.verify"
    ])
    expect(actions.every((action) => /^[a-f0-9]{64}$/.test(action.digest))).toBe(true)
    const provenance = JSON.parse(readFileSync(join(leanRulesRoot, "provenance.json"), "utf8"))
    expect(sha(readFileSync(join(leanRulesRoot, "mods/rules-bundle.ts")))).toBe(provenance.sha256)
  })

  it("compiles separately replaceable providers and doctors the five-step source", async () => {
    const sourceSet = await readProjectSourceSet(sourceSetRoot, () => {})
    expect(sourceSet.declaration.project).toBe("project")
    expect(sourceSet.dependencies.map((dependency) => dependency.name).sort()).toEqual([
      "autobiz-lean-delivery",
      "autobiz-lean-knowledge",
      "autobiz-lean-rules"
    ])
    const actions = await catalog(),
      source = sourceAt()
    const compiled = compileNativeComposition(source, {
      files: readNativeCompositionFiles(root, source),
      actionCatalog: actions
    })
    const runtime = parseProjectRuntimeManifest(compiled.runtime)
    expect(runtime.stages.map((stage) => stage.id)).toEqual([
      "baseline",
      "definition",
      "solution",
      "code",
      "delivery"
    ])
    expect(runtime.stages.map((stage) => stage.resultApproval)).toEqual([
      "human",
      undefined,
      "human",
      "human",
      "human"
    ])
    expect(runtime.stages[3].executionMode).toBe("workflow")
    expect(
      compiled.actionLock.bindings
        .filter((binding) => binding.id.endsWith(".evidence"))
        .every((binding) => binding.config.nativeCompositionProvider !== undefined)
    ).toBe(true)
    const bundle = createAuthoringSourceBundle(
      compiled.files.map(({ path, bytes }) => ({
        path,
        text: bytes.toString("utf8")
      }))
    )
    expect(inspectProjectSource(bundle, [], actions).report.diagnostics).toEqual([])
    expect((await testProjectSource(bundle, runtime)).valid).toBe(true)
    expect(() =>
      compileNativeComposition(source, {
        files: readNativeCompositionFiles(root, source),
        actionCatalog: []
      })
    ).toThrow("PROVIDER_UNRESOLVED")
  })

  it("keeps full check references while narrowing initial reading and rejects undeclared context", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "autobiz-lean-inputs-"))
    try {
      const source = sourceAt(),
        actions = await catalog()
      const files = readNativeCompositionFiles(root, source)
      const compile = (value: unknown) =>
        compileNativeComposition(value, { files, actionCatalog: actions })
      const compiled = compile(source)
      const project = {
        ...hostProjectFixture(workspace),
        schemaVersion: 1 as const,
        stateOwner: "host" as const,
        version: 1,
        stageIndex: 3,
        status: "active" as const,
        createdAt: 1,
        updatedAt: 1,
        manifest: parseProjectRuntimeManifest(compiled.runtime)
      }
      const fixture = leanFixture()
      const actualLock = runHelper(workspace, "design-lock.py", {
        feature: fixture.definition.feature,
        lockedAt: fixture.solution.designLock.lockedAt,
        design: fixture.solution.design
      })
      expect(actualLock).toEqual(fixture.solution.designLock)
      expect(runHelper(workspace, "solution-pipeline.py", fixture.solution)).toEqual(
        fixture.solution.plan.parallelBatchPipeline
      )
      writeFileSync(join(workspace, "RequestBaseline.json"), JSON.stringify(fixture.baseline))
      writeFileSync(join(workspace, "Definition.json"), JSON.stringify(fixture.definition))
      writeFileSync(join(workspace, "Solution.json"), JSON.stringify(fixture.solution))
      writeFileSync(
        join(workspace, "Code.json"),
        JSON.stringify({ feature: "orders", runId: "selection-only" })
      )
      expect(project.manifest.stages[3].contextArtifactIds).toEqual(["solution"])
      const captured = captureProjectArtifactReference(project, compiled.actionLock, "code", 28000)
      expect(captured.files.map(([path]) => path)).toEqual([
        "Code.json",
        "RequestBaseline.json",
        "Definition.json",
        "Solution.json"
      ])
      writeFileSync(
        join(workspace, "Definition.json"),
        JSON.stringify({
          ...fixture.definition,
          requirements: ["changed outside initial reading list"]
        })
      )
      expect(
        captureProjectArtifactReference(project, compiled.actionLock, "code", 28000).input
      ).not.toEqual(captured.input)
      for (const contextArtifactIds of [["unknown"], ["code"], ["definition", "definition"]]) {
        const invalid = structuredClone(source)
        invalid.modules[1].contextArtifactIds = contextArtifactIds
        expect(() => compile(invalid)).toThrow(/CONTEXT_INPUT/)
        const manifest = parseProjectRuntimeManifest(compiled.runtime)
        manifest.stages[1].contextArtifactIds = contextArtifactIds
        expect(() => parseProjectRuntimeManifest(manifest)).toThrow()
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("runs all retained pure business gates directly on new documents and rejects corrupted evidence", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "autobiz-four-business-"))
    try {
      const act = await handler(leanRulesRoot, "business")
      const fixture = leanFixture()
      const save = () => {
        writeFileSync(join(workspace, "RequestBaseline.json"), JSON.stringify(fixture.baseline))
        writeFileSync(join(workspace, "Definition.json"), JSON.stringify(fixture.definition))
        writeFileSync(join(workspace, "Solution.json"), JSON.stringify(fixture.solution))
      }
      save()
      const run = async (action: string, input: unknown) =>
        act(
          {
            process: {
              run: async (argv: string[], options: { stdin: string }) => {
                const result = spawnSync(argv[0], argv.slice(1), {
                  cwd: workspace,
                  input: options.stdin,
                  encoding: "utf8"
                })
                if (result.error) throw result.error
                return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
              }
            }
          },
          {
            action,
            input: {
              input,
              config: {
                artifactRoles: Object.fromEntries(
                  ["baseline", "definition", "solution", "code", "delivery"]
                    .slice(
                      0,
                      action === "baseline.verify"
                        ? 1
                        : action === "definition.verify"
                          ? 2
                          : action === "delivery.documents"
                            ? 5
                            : 3
                    )
                    .map((role) => [role, role])
                )
              }
            }
          }
        )
      for (const stage of ["baseline", "definition", "solution"] as const)
        expect((await run(stage + ".verify", reference(workspace, stage))).output.passed).toBe(true)
      expect(
        (
          await run("solution.inspect", {
            artifactPaths: {
              baseline: "RequestBaseline.json",
              definition: "Definition.json",
              solution: "Solution.json"
            }
          })
        ).output.passed
      ).toBe(true)
      expect((await run("solution.inspect", { invented: true })).output.passed).toBe(false)
      const baseline = structuredClone(fixture)
      fixture.definition.prd = fixture.definition.prd.replace(
        "订单查询必须在2秒内返回",
        "删掉困难验收"
      )
      save()
      expect(
        (await run("definition.verify", reference(workspace, "definition"))).output.passed
      ).toBe(false)
      Object.assign(fixture, structuredClone(baseline))
      fixture.definition.proposal = fixture.definition.proposal.replace(
        "- order-query:",
        "- missing:"
      )
      save()
      expect(
        (await run("definition.verify", reference(workspace, "definition"))).output.passed
      ).toBe(false)
      Object.assign(fixture, structuredClone(baseline))
      fixture.solution.design += "正文改了但锁未更新\n"
      save()
      expect((await run("solution.verify", reference(workspace, "solution"))).output.passed).toBe(
        false
      )
      Object.assign(fixture, structuredClone(baseline))
      fixture.solution.batches.B001.tasks[0].specRefs = ["specs/order-query/spec.md#SCN-999"]
      save()
      expect((await run("solution.verify", reference(workspace, "solution"))).output.passed).toBe(
        false
      )
      Object.assign(fixture, structuredClone(baseline))
      save()
      const stale = reference(workspace, "solution")
      writeFileSync(join(workspace, "Definition.json"), JSON.stringify(fixture.definition) + "\n")
      expect((await run("solution.verify", stale)).output.passed).toBe(false)
      save()
      writeFileSync(
        join(workspace, "Code.json"),
        JSON.stringify({ feature: "orders", runId: "fixture-run" })
      )
      const archive = Object.fromEntries(
        ["RequestBaseline.json", "Definition.json", "Solution.json", "Code.json"].map((name) => {
          const text = readFileSync(join(workspace, name), "utf8")
          return [name, { text, sha256: sha(text) }]
        })
      )
      expect(runHelper(workspace, "archive-delivery.py")).toEqual(archive)
      const delivery = {
        feature: "orders",
        codeRunId: "fixture-run",
        publication: { mode: "not-requested", status: "prepared-only" },
        checklist:
          "## 交付范围\nRequestBaseline.json Definition.json Solution.json\n## 验证证据\nCode.json fixture-run\n## 发布状态\n未请求外部发布 prepared-only\n## 已知阻断问题\n无\n## 回滚计划\n回滚实际提交",
        prBody: "待审准备成果",
        archive
      }
      writeFileSync(join(workspace, "Delivery.json"), JSON.stringify(delivery))
      expect(
        (await run("delivery.documents", reference(workspace, "delivery"))).output.passed
      ).toBe(true)
      delivery.archive["Definition.json"].text += "changed"
      writeFileSync(join(workspace, "Delivery.json"), JSON.stringify(delivery))
      expect(
        (await run("delivery.documents", reference(workspace, "delivery"))).output.passed
      ).toBe(false)
      delivery.archive = runHelper(workspace, "archive-delivery.py")
      delivery.publication.status = "published"
      writeFileSync(join(workspace, "Delivery.json"), JSON.stringify(delivery))
      expect(
        (await run("delivery.documents", reference(workspace, "delivery"))).output.passed
      ).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 30000)

  it("keeps all unannotated organization knowledge and maps explicit stage annotations to merged steps", async () => {
    expect(
      selectStageKnowledge(
        documents,
        selected,
        "definition",
        sourceAt().contextAction!.config!.stageTags
      ).documents.map((row) => row.path)
    ).toEqual(["AGENTS.md", "orders.md"])
    expect(
      selectStageKnowledge(
        documents,
        selected,
        "solution",
        sourceAt().contextAction!.config!.stageTags
      ).documents
    ).toHaveLength(3)
    const unannotated = documents.map((document) => ({
      ...document,
      text: document.text.replace("autobiz_stages: [design, plan, code]\n", "")
    }))
    expect(
      selectStageKnowledge(
        unannotated,
        selected,
        "definition",
        sourceAt().contextAction!.config!.stageTags
      ).documents
    ).toHaveLength(3)
    const invalid = documents.map((document) => ({
      ...document,
      text: document.text.replace("[design, plan, code]", "[invented]")
    }))
    expect(() =>
      selectStageKnowledge(
        invalid,
        selected,
        "solution",
        sourceAt().contextAction!.config!.stageTags
      )
    ).toThrow("ANNOTATION_INVALID")
    expect((await context(knowledgeRoot, root, "definition")).output.selectedPaths).toEqual([
      "AGENTS.md",
      "orders.md"
    ])
  })

  it("replaces a genuinely compiled independent knowledge provider using the public action lock", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "autobiz-lean-provider-"))
    try {
      cpSync(knowledgeRoot, temporary, { recursive: true })
      for (const path of ["plugin.json", "mods/manifest.json"]) {
        const file = join(temporary, path)
        writeFileSync(
          file,
          readFileSync(file, "utf8").replaceAll("autobiz-lean-knowledge", "company-knowledge")
        )
      }
      const replacement = await provider(temporary, "installed-company-knowledge")
      const source = sourceAt()
      source.contextAction!.provider.plugin = "company-knowledge"
      const compiled = compileNativeComposition(source, {
        files: readNativeCompositionFiles(root, source),
        actionCatalog: [
          ...(await provider(leanRulesRoot, "rules")),
          ...(await provider(deliveryRoot, "delivery")),
          ...replacement
        ]
      })
      expect(
        compiled.actionLock.bindings.find((binding) => binding.id === "knowledge.context")?.ref
      ).toMatchObject({
        plugin: "company-knowledge",
        pluginId: "installed-company-knowledge",
        digest: replacement[0].digest
      })
      expect((await context(temporary, root, "definition")).output.passed).toBe(true)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })

  it("measures the actual compiled instruction and provider text including mandatory contract reads", async () => {
    const oldSource = sourceAt(oldRoot),
      source = sourceAt()
    const old = compileNativeComposition(oldSource, {
      files: readNativeCompositionFiles(oldRoot, oldSource),
      actionCatalog: [
        ...(await provider(rulesRoot, "old-rules")),
        ...(await provider(oldKnowledgeRoot, "old-knowledge"))
      ]
    })
    const lean = compileNativeComposition(source, {
      files: readNativeCompositionFiles(root, source),
      actionCatalog: await catalog()
    })
    const measure = async (
      value: typeof old,
      path: string,
      providerRoot: string,
      stages: string[]
    ) => {
      const rows: Array<{
        stage: string
        instructions: number
        knowledge: number
        requiredReads: number
        platformReads: number
        materialActions: number
        requiredReadOperations: number
        operations: number
      }> = []
      for (const stage of stages) {
        const prepared = await context(providerRoot, path, stage)
        const requiredReadOperations = ["baseline", "definition", "solution"].includes(stage)
          ? 1
          : 0
        rows.push({
          stage,
          instructions: value.files.find((file) => file.path === `skills/native-${stage}/SKILL.md`)!
            .bytes.length,
          knowledge: Buffer.byteLength(prepared.text),
          requiredReads: requiredReadOperations
            ? readFileSync(join(path, "contracts", stage + ".md")).length
            : 0,
          platformReads: prepared.snapshotReads,
          materialActions: prepared.operations,
          requiredReadOperations,
          operations: prepared.snapshotReads + prepared.operations + requiredReadOperations
        })
      }
      return rows
    }
    const before = await measure(
      old,
      oldRoot,
      oldKnowledgeRoot,
      oldSource.modules.map((module) => module.id)
    )
    const after = await measure(
      lean,
      root,
      knowledgeRoot,
      source.modules.map((module) => module.id)
    )
    const sum = (rows: typeof before) =>
      rows.reduce((sum, row) => sum + row.instructions + row.knowledge + row.requiredReads, 0)
    expect(sum(after)).toBeLessThan(sum(before) * 0.65)
    expect(after.reduce((sum, row) => sum + row.operations, 0)).toBeLessThan(
      before.reduce((sum, row) => sum + row.operations, 0)
    )
    const totals = (rows: typeof before) => ({
      stages: rows.length,
      instructions: rows.reduce((sum, row) => sum + row.instructions, 0),
      knowledge: rows.reduce((sum, row) => sum + row.knowledge, 0),
      requiredReads: rows.reduce((sum, row) => sum + row.requiredReads, 0),
      bytes: sum(rows),
      platformReads: rows.reduce((sum, row) => sum + row.platformReads, 0),
      materialActions: rows.reduce((sum, row) => sum + row.materialActions, 0),
      requiredReadOperations: rows.reduce((sum, row) => sum + row.requiredReadOperations, 0),
      operations: rows.reduce((sum, row) => sum + row.operations, 0)
    })
    console.log(
      "AUTOBIZ_FIVE_STAGE_PREPARED_COMPONENT_BYTES=" +
        JSON.stringify({
          scope:
            "compiled Skill bytes + actual provider context text + mandatory contract reads on the fixed three-document knowledge fixture",
          excluded: [
            "Host envelope",
            "artifact bodies",
            "workflow source",
            "subagent prompts",
            "tool/process outputs",
            "retries",
            "model tokens"
          ],
          before,
          after,
          totals: { before: totals(before), after: totals(after) }
        })
    )
  }, 30000)
})
