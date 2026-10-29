import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../../types"
import type { DevelopmentScope } from "../v2/development-session"
import { publishDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import { BusinessModAssemblyService } from "../../plugins/business-mod-assembly-service"
import { assertPackageExtensionCompatibility } from "../../plugins/extension-contract"
import { assertHostPackageSupported } from "../../harness-board/project-runtime/package-preflight"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { BUSINESS_MOD_MANIFEST } from "../../../shared/business-mods"
import { CreatorBusinessService, setCreatorBusinessService } from "./creator-business"
import { setModDevelopmentService, type ModDevelopmentService } from "./development-service"
import { createModBusinessTool } from "../../agent/tools/mod-business-tool"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { projectAuthoringSessions } from "./project-authoring-session"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function write(root: string, path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "creator-first-modularization-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const source = join(root, "original")
  await write(source, "plugin.json", {
    name: "original-project",
    version: "1.0.0",
    skills: "skills",
    hooks: "hooks/hooks.json"
  })
  await write(source, "hooks/hooks.json", { hooks: { PreToolUse: [] } })
  await write(source, "knowledge/policy.md", "Use the original knowledge policy: ${POLICY_ROOT}\n")
  await write(source, ".env", "API_KEY=excluded-private-value\n")
  await write(source, "resources/service.json", {
    token: "private-display-value",
    endpoint: "https://example.invalid"
  })
  await write(
    source,
    "skills/prepare/SKILL.md",
    "---\nname: prepare\ndescription: Make a draft\n---\nRead knowledge/policy.md and write draft.json.\n"
  )
  await write(source, "devclaw.project-runtime.json", {
    apiVersion: "devclaw.project-runtime/v1",
    plugin: { id: "original-project", version: "1.0.0" },
    mode: "host",
    stateOwner: "host",
    stages: [
      {
        id: "prepare",
        title: "Prepare",
        skill: "skills/prepare/SKILL.md",
        actionIds: [],
        artifactIds: ["draft"],
        checkIds: ["draft-schema"],
        approval: "human"
      }
    ],
    actions: [],
    artifacts: [{ id: "draft", path: "draft.json", required: true }],
    checks: [
      {
        id: "draft-schema",
        kind: "json-schema",
        artifactId: "draft",
        sideEffect: "read",
        schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }
      }
    ],
    environment: [{ id: "POLICY_ROOT", description: "Original environment", required: true }],
    capabilities: {
      execution: true,
      conditionalTransition: false,
      idempotency: false,
      reconciliation: false,
      cancellation: true
    }
  })
  await write(source, "tests/project-contract.json", {
    apiVersion: "devclaw.project-contract/v1",
    cases: [
      { id: "missing-draft", stageId: "prepare", files: [], expected: "failed" },
      {
        id: "valid-draft",
        stageId: "prepare",
        files: [{ path: "draft.json", text: '{"title":"actual test fixture"}' }],
        expected: "passed"
      }
    ]
  })
  const plugin = {
    id: "installed-original",
    name: "original-project",
    version: "1.0.0",
    path: source,
    enabled: true,
    updatedAt: 100
  } as unknown as PluginMetadata
  const scope = {
    threadId: "creator",
    workspace: "workspace",
    incarnation: { token: `creator-incarnation-${randomUUID()}`, legacyCreatedAt: 1 }
  } as DevelopmentScope
  let busy = false
  const plugins = [plugin]
  const values = new Map<string, string>()
  const changed = vi.fn()
  let idleHandler: ((threadId: string) => void) | undefined
  const install = vi.fn(async () => ({ success: true }))
  const validate = vi.fn(async (directory: string) => {
    assertPackageExtensionCompatibility(directory)
    assertHostPackageSupported(
      directory,
      parseProjectRuntimeManifest(
        JSON.parse(await readFile(join(directory, "devclaw.project-runtime.json"), "utf8"))
      )
    )
  })
  const assembly = new BusinessModAssemblyService(join(root, "assembly"), {
    plugins: () => plugins,
    validatePackage: validate,
    install,
    invalidate: () => {}
  })
  function create() {
    const service = new CreatorBusinessService({
      root: join(root, "creator"),
      assembly,
      settings: {
        getSetting: (key: string, fallback: string) => values.get(key) ?? fallback,
        compareAndSetSetting: (key: string, previous: string | undefined, value: string) => {
          if (values.get(key) !== previous) return false
          values.set(key, value)
          return true
        }
      },
      plugins: () => plugins,
      context: () => ({ scope, assertCurrent: () => {} }) as never,
      readContext: () => ({ scope, assertCurrent: () => {} }) as never,
      busy: () => busy,
      onIdle: (listener) => {
        idleHandler = listener
        return () => {
          idleHandler = undefined
        }
      },
      changed
    })
    cleanup.push(async () => service.close())
    return service
  }
  const service = create()
  const settle = async (outcome: "completed" | "cancelled" = "completed") => {
    publishDevelopmentTurnSettlement({
      threadId: "creator",
      turnId: "modularization-turn",
      incarnation: scope.incarnation,
      outcome
    })
    await Promise.resolve()
  }
  async function request() {
    const inspected = await service.inspectRaw("creator", plugin.id)
    const status = await service.requestModularization(
      "creator",
      {
        rawInspectionId: inspected.rawInspectionId,
        sourceDigest: inspected.sourceDigest
      },
      "modularization-turn",
      () => {}
    )
    return { inspected, status }
  }
  return {
    root,
    source,
    service,
    scope,
    plugin,
    plugins,
    install,
    changed,
    idle: () => idleHandler?.("creator"),
    validate,
    create,
    request,
    settle,
    busy: (value: boolean) => {
      busy = value
    }
  }
}

describe("Creator original plugin modularization journey", () => {
  it("reads and redacts larger source files for paged inspection without mutating source", async () => {
    const f = await fixture()
    const text = 'api_key = "PRIVATE_LARGE_SOURCE_CANARY"\n' + "# reviewed source\n".repeat(16_000)
    await write(f.source, "hooks/large-source.py", text)
    const inspected = await f.service.inspectRaw("creator", f.plugin.id)
    expect(inspected).toHaveProperty("schemaAction", "modularization_schema(cursor)")
    const read = await f.service.readRawAsset(
      "creator",
      inspected.rawInspectionId,
      "hooks/large-source.py"
    )
    expect(Buffer.byteLength(read.text)).toBeGreaterThan(64 * 1024)
    expect(read).toMatchObject({
      redacted: true,
      originalPreserved: true,
      sourceDigest: inspected.sourceDigest
    })
    expect(read.text).not.toContain("PRIVATE_LARGE_SOURCE_CANARY")
    expect(read.text.endsWith("# reviewed source\n")).toBe(true)
    expect(await readFile(join(f.source, "hooks/large-source.py"), "utf8")).toBe(text)
  })

  it.each([
    {
      key: "connection",
      declaration: { sensitive: true, default: "SCHEMA_PRIVATE_DEFAULT" },
      canary: "SCHEMA_PRIVATE_DEFAULT",
      expected: "[redacted]"
    },
    {
      key: "connection",
      declaration: {
        sensitive: true,
        multiple: true,
        default: ["ARRAY_PRIVATE_DEFAULT", "${TOKEN_FROM_ENV}", ""]
      },
      canary: "ARRAY_PRIVATE_DEFAULT",
      expected: ["[redacted]", "${TOKEN_FROM_ENV}", ""]
    },
    {
      key: "serviceToken",
      declaration: { default: "UNMARKED_PRIVATE_DEFAULT" },
      canary: "UNMARKED_PRIVATE_DEFAULT",
      expected: "[redacted]"
    }
  ])(
    "redacts supported schema credential defaults from raw source and migration catalog ($canary)",
    async ({ key, declaration, canary, expected }) => {
      const f = await fixture()
      const manifest = JSON.parse(await readFile(join(f.source, "plugin.json"), "utf8"))
      const field = {
        type: "string",
        title: "Token connection label",
        description: "Use a token supplied at installation",
        ...declaration
      }
      // This is an actual accepted native schema, not an unsupported password-shaped fixture.
      expect(parseFunctionUserConfig({ [key]: field })).toBeDefined()
      manifest.userConfig = { [key]: field }
      await write(f.source, "plugin.json", manifest)
      const original = await readFile(join(f.source, "plugin.json"))
      const digest = createHash("sha256").update(original).digest("hex")
      const inspected = await f.service.inspectRaw("creator", f.plugin.id)
      expect(inspected.status).toBe("needs-authoring")
      expect(inspected.catalog).toBeUndefined()
      expect(JSON.stringify(inspected)).not.toContain(canary)
      const raw = await f.service.readRawAsset("creator", inspected.rawInspectionId, "plugin.json")
      expect(raw).toMatchObject({
        redacted: true,
        originalPreserved: true,
        digest,
        sourceDigest: inspected.sourceDigest
      })
      expect(raw.text).not.toContain(canary)
      const projected = JSON.parse(raw.text).userConfig[key]
      expect(projected.default).toEqual(expected)
      expect(projected.title).toBe(field.title)
      expect(projected.description).toBe(field.description)
      expect(projected.type).toBe("string")
      expect(await readFile(join(f.source, "plugin.json"))).toEqual(original)
      expect((await f.service.inspectRaw("creator", f.plugin.id)).sourceDigest).toBe(
        inspected.sourceDigest
      )
    }
  )

  it("preserves placeholder defaults, schema labels and non-sensitive token counts without changing source bytes", async () => {
    const f = await fixture()
    const manifest = JSON.parse(await readFile(join(f.source, "plugin.json"), "utf8"))
    manifest.userConfig = {
      serviceToken: {
        type: "string",
        title: "Token label",
        description: "Token help",
        default: "${SERVICE_TOKEN}"
      },
      maxTokens: {
        type: "number",
        title: "Token count",
        description: "Output budget",
        default: 2048
      },
      style: {
        type: "string",
        title: "Style",
        description: "Display labels",
        options: ["token-reference", "brief"],
        default: "token-reference"
      }
    }
    expect(parseFunctionUserConfig(manifest.userConfig)).toBeDefined()
    await write(f.source, "plugin.json", manifest)
    const original = await readFile(join(f.source, "plugin.json"))
    const inspected = await f.service.inspectRaw("creator", f.plugin.id)
    expect(inspected.status).toBe("candidate")
    expect(inspected.catalog?.kernel?.pluginFields?.userConfig).toEqual(manifest.userConfig)
    const raw = await f.service.readRawAsset("creator", inspected.rawInspectionId, "plugin.json")
    expect(raw.redacted).toBe(false)
    expect(raw.text).toBe(original.toString("utf8"))
    expect(await readFile(join(f.source, "plugin.json"))).toEqual(original)
  })

  it("keeps explicit sensitive defaults hidden even when their schema is invalid", async () => {
    const f = await fixture()
    const manifest = JSON.parse(await readFile(join(f.source, "plugin.json"), "utf8"))
    manifest.userConfig = {
      connection: {
        type: "password",
        title: "Connection label",
        description: "Invalid schema must be repaired",
        sensitive: true,
        default: { values: ["INVALID_SCHEMA_PRIVATE_DEFAULT", "${TOKEN_FROM_ENV}"] }
      }
    }
    expect(() => parseFunctionUserConfig(manifest.userConfig)).toThrow()
    await write(f.source, "plugin.json", manifest)
    const original = await readFile(join(f.source, "plugin.json"))
    const inspected = await f.service.inspectRaw("creator", f.plugin.id)
    expect(JSON.stringify(inspected)).not.toContain("INVALID_SCHEMA_PRIVATE_DEFAULT")
    const raw = await f.service.readRawAsset("creator", inspected.rawInspectionId, "plugin.json")
    expect(raw.redacted).toBe(true)
    expect(raw.text).not.toContain("INVALID_SCHEMA_PRIVATE_DEFAULT")
    expect(JSON.parse(raw.text).userConfig.connection).toMatchObject({
      title: "Connection label",
      description: "Invalid schema must be repaired",
      default: { values: ["[redacted]", "${TOKEN_FROM_ENV}"] }
    })
    expect(await readFile(join(f.source, "plugin.json"))).toEqual(original)
  })

  it.each([
    { type: "boolean", default: false },
    { type: "number", default: 0 }
  ])(
    "redacts actual sensitive $type defaults while retaining valid native metadata",
    async (declaration) => {
      const f = await fixture()
      const manifest = JSON.parse(await readFile(join(f.source, "plugin.json"), "utf8"))
      manifest.userConfig = {
        connection: {
          title: "Private setting",
          description: "Set privately",
          sensitive: true,
          ...declaration
        }
      }
      expect(parseFunctionUserConfig(manifest.userConfig)).toBeDefined()
      await write(f.source, "plugin.json", manifest)
      const original = await readFile(join(f.source, "plugin.json"))
      const inspected = await f.service.inspectRaw("creator", f.plugin.id)
      const raw = await f.service.readRawAsset("creator", inspected.rawInspectionId, "plugin.json")
      expect(raw.redacted).toBe(true)
      expect(JSON.parse(raw.text).userConfig.connection).toMatchObject({
        type: declaration.type,
        default: "[redacted]",
        sensitive: true
      })
      expect(await readFile(join(f.source, "plugin.json"))).toEqual(original)
    }
  )

  it("keeps credential ancestry across nested JSON source values, including case-varied JSON paths", async () => {
    const f = await fixture()
    const path = "resources/config.JSON"
    await write(f.source, path, {
      serviceToken: { values: ["NESTED_PRIVATE_DEFAULT", "${TOKEN_ENV}"] },
      maxTokens: 2048,
      description: "Ordinary token count metadata"
    })
    const original = await readFile(join(f.source, path))
    const inspected = await f.service.inspectRaw("creator", f.plugin.id)
    const raw = await f.service.readRawAsset("creator", inspected.rawInspectionId, path)
    expect(raw.redacted).toBe(true)
    expect(raw.text).not.toContain("NESTED_PRIVATE_DEFAULT")
    expect(JSON.parse(raw.text)).toEqual({
      serviceToken: { values: ["[redacted]", "${TOKEN_ENV}"] },
      maxTokens: 2048,
      description: "Ordinary token count metadata"
    })
    expect(await readFile(join(f.source, path))).toEqual(original)
  })

  it("requires a fresh confirmation for changed additions under the same original source digest", async () => {
    const f = await fixture()
    const raw = await f.service.inspectRaw("creator", f.plugin.id)
    const catalog = structuredClone(raw.catalog!)
    catalog.kernel!.resources.push("knowledge/migration.md")
    const input = {
      rawInspectionId: raw.rawInspectionId,
      sourceDigest: raw.sourceDigest,
      catalog,
      modularizationFiles: [{ path: "knowledge/migration.md", text: "First reviewed source\n" }]
    }
    const first = await f.service.requestModularization(
      "creator",
      input,
      "modularization-turn",
      () => {}
    )
    input.modularizationFiles[0].text = "Changed new source\n"
    const second = await f.service.requestModularization(
      "creator",
      input,
      "modularization-turn",
      () => {}
    )
    expect(second.modularization?.sourceDigest).toBe(first.modularization?.sourceDigest)
    expect(second.modularization?.requestId).not.toBe(first.modularization?.requestId)
    input.modularizationFiles[0].text = "Mutation after request; must not become approved\n"
    await f.settle()
    await expect(
      f.service.approveModularization("creator", "workspace", first.modularization!)
    ).rejects.toThrow("CONFIRMATION_REQUIRED")
    const ready = await f.service.approveModularization(
      "creator",
      "workspace",
      second.modularization!
    )
    expect(ready.modularization?.phase).toBe("ready")
    const file = await f.service.readAsset(
      "creator",
      ready.modularization!.inspectionId!,
      "knowledge/migration.md"
    )
    expect(file.text).toBe("Changed new source\n")
    expect(existsSync(join(f.source, "knowledge/migration.md"))).toBe(false)
  })
  it("takes a classic Skill-only plugin through additive authoring, native confirmation and the real Host trial request", async () => {
    const f = await fixture()
    await rm(join(f.source, "devclaw.project-runtime.json"))
    await rm(join(f.source, "tests/project-contract.json"))
    expect(existsSync(join(f.source, "devclaw.project-runtime.json"))).toBe(false)
    expect(existsSync(join(f.source, BUSINESS_MOD_MANIFEST))).toBe(false)
    const originalSkill = await readFile(join(f.source, "skills/prepare/SKILL.md"))
    const originalHooks = await readFile(join(f.source, "hooks/hooks.json"))
    const additions = [
      {
        path: "skills/qualify/SKILL.md",
        text: "---\nname: qualify\ndescription: Qualify the real draft\n---\nRead draft.json and knowledge/qualification-policy.md, then write quality.json.\n"
      },
      {
        path: "knowledge/qualification-policy.md",
        text: "Require an actual reviewed draft before qualification.\n"
      },
      {
        path: "tests/project-contract.json",
        text: JSON.stringify({
          apiVersion: "devclaw.project-contract/v1",
          cases: [
            { id: "missing-draft", stageId: "prepare", files: [], expected: "failed" },
            {
              id: "valid-draft",
              stageId: "prepare",
              files: [{ path: "draft.json", text: '{"title":"real draft fixture"}' }],
              expected: "passed"
            },
            {
              id: "invalid-quality",
              stageId: "qualify",
              files: [{ path: "quality.json", text: '{"checked":false}' }],
              expected: "failed"
            },
            {
              id: "valid-quality",
              stageId: "qualify",
              files: [{ path: "quality.json", text: '{"checked":true}' }],
              expected: "passed"
            }
          ]
        })
      }
    ]
    setCreatorBusinessService(f.service)
    setModDevelopmentService({
      isCreatorMode: () => true,
      captureCreatorMode: () => () => {},
      claimAuthoringBudget: () => {}
    } as unknown as ModDevelopmentService)
    claimLocalThreadRunLease({
      threadId: "creator",
      owner: "desktop",
      runId: "modularization-turn"
    })
    try {
      const tool = createModBusinessTool({ threadId: "creator", workspace: "workspace" })
      const raw = JSON.parse(await tool.invoke({ action: "inspect_raw", pluginId: f.plugin.id }))
      expect(raw).toMatchObject({
        ok: true,
        result: { status: "needs-authoring", runtime: "unknown" }
      })
      const module = (
        id: string,
        artifact: string,
        schema: Record<string, unknown>,
        index: number
      ) => ({
        id,
        title: id,
        node: { id, skill: id, order: index * 10 },
        skill: { entry: `skills/${id}/SKILL.md`, resources: [] },
        resources: [],
        dependencies: { required: index ? ["prepare"] : [], advisory: [] },
        checks: { validators: [], guards: [] },
        host: {
          stage: {
            actionIds: [],
            artifactIds: [artifact],
            checkIds: [`${artifact}-schema`],
            approval: "human"
          },
          actions: [],
          artifacts: [{ id: artifact, path: `${artifact}.json`, required: true }],
          checks: [
            {
              id: `${artifact}-schema`,
              artifactId: artifact,
              kind: "json-schema",
              sideEffect: "read",
              schema
            }
          ],
          environment: []
        }
      })
      const catalog = {
        apiVersion: "devclaw.business-mods/v1",
        kind: "catalog",
        kernel: {
          id: "classic.modularized",
          version: "1.0.0",
          runtime: { adapter: "host-linear-v1" },
          pluginFields: { hooks: "hooks/hooks.json", skills: "skills" },
          resources: [
            ...raw.result.files
              .filter(
                (file: { path: string }) =>
                  file.path !== "plugin.json" && file.path !== "skills/prepare/SKILL.md"
              )
              .map((file: { path: string }) => file.path),
            "tests/project-contract.json",
            "knowledge/qualification-policy.md"
          ]
        },
        modules: [
          module(
            "prepare",
            "draft",
            { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
            0
          ),
          module(
            "qualify",
            "quality",
            { type: "object", properties: { checked: { const: true } }, required: ["checked"] },
            1
          )
        ]
      }
      const rejected = JSON.parse(
        await tool.invoke({
          action: "request_modularization",
          rawInspectionId: raw.result.rawInspectionId,
          sourceDigest: raw.result.sourceDigest,
          modularizationCatalog: catalog,
          modularizationFiles: [...additions, additions[0]]
        })
      )
      expect(rejected).toMatchObject({
        ok: false,
        error: "BUSINESS_MOD_CATALOG_INVALID",
        diagnostics: [
          {
            path: `modularizationFiles.${additions.length}.path`,
            code: "PLUGIN_MODULARIZATION_FILE_COLLISION",
            message: expect.any(String)
          }
        ]
      })
      expect(f.service.status("creator").modularization).toBeUndefined()
      const requested = JSON.parse(
        await tool.invoke({
          action: "request_modularization",
          rawInspectionId: raw.result.rawInspectionId,
          sourceDigest: raw.result.sourceDigest,
          modularizationCatalog: catalog,
          modularizationFiles: additions
        })
      )
      expect(requested).toMatchObject({
        ok: true,
        result: { modularization: { phase: "needs-confirmation", canConfirm: false } }
      })
      releaseLocalThreadRunLease("creator", "desktop", "modularization-turn")
      await f.settle()
      const pending = f.service.status("creator").modularization!
      expect(pending.diagnostics.join("\n")).toContain("本次仅新增 3")
      expect(pending.diagnostics.join("\n")).toContain("tests/project-contract.json")
      expect(existsSync(join(f.source, "tests/project-contract.json"))).toBe(false)
      const approved = await f.service.approveModularization("creator", "workspace", pending)
      expect(approved.modularization?.phase).toBe("ready")
      const inspection = await f.service.inspectionPage(
        "creator",
        approved.modularization!.inspectionId!
      )
      expect(inspection.mods.map((mod) => mod.id)).toEqual(["prepare", "qualify"])
      const preview = await f.service.preview("creator", {
        name: "classic-derived-project",
        version: "1.0.0",
        sources: [{ inspectionId: inspection.id, modIds: ["qualify"] }]
      })
      expect(preview.valid).toBe(true)
      expect(preview.steps.map((step) => step.id)).toEqual(["prepare", "qualify"])
      claimLocalThreadRunLease({
        threadId: "creator",
        owner: "desktop",
        runId: "classic-host-route-turn"
      })
      const trialTool = createModBusinessTool({ threadId: "creator", workspace: "workspace" })
      const trial = JSON.parse(
        await trialTool.invoke({
          action: "request_trial",
          previewId: preview.previewId,
          goal: "Create and validate a real qualified draft"
        })
      )
      expect(trial).toMatchObject({
        ok: true,
        result: { trialRoute: "host", executed: false, projectTrial: { id: expect.any(String) } }
      })
      expect(f.validate).toHaveBeenCalledOnce()
      expect(f.install).not.toHaveBeenCalled()
      expect(await readFile(join(f.source, "skills/prepare/SKILL.md"))).toEqual(originalSkill)
      expect(await readFile(join(f.source, "hooks/hooks.json"))).toEqual(originalHooks)
      expect(existsSync(join(f.source, "devclaw.project-runtime.json"))).toBe(false)
      const request = projectAuthoringSessions.trialRequest(f.scope)!
      const draft = projectAuthoringSessions.read(f.scope, request.draftId)
      expect(draft.development?.status).toBe("prepared")
      for (const file of additions)
        expect(draft.source.files.find((value) => value.path === file.path)?.text).toBe(file.text)
      cleanup.push(() => rm(dirname(draft.directory), { recursive: true, force: true }))
    } finally {
      releaseLocalThreadRunLease("creator", "desktop", "modularization-turn")
      releaseLocalThreadRunLease("creator", "desktop", "classic-host-route-turn")
      setCreatorBusinessService(undefined)
      setModDevelopmentService(undefined)
    }
  })
  it("returns the real Host trial route and original request through the business tool without claiming success", async () => {
    const f = await fixture()
    const { status } = await f.request()
    await f.settle()
    const approved = await f.service.approveModularization(
      "creator",
      "workspace",
      status.modularization!
    )
    const preview = await f.service.preview("creator", {
      name: "host-route-project",
      version: "1.0.0",
      sources: [{ inspectionId: approved.modularization!.inspectionId!, modIds: ["prepare"] }]
    })
    setCreatorBusinessService(f.service)
    setModDevelopmentService({
      isCreatorMode: () => true,
      captureCreatorMode: () => () => {},
      claimAuthoringBudget: () => {}
    } as unknown as ModDevelopmentService)
    claimLocalThreadRunLease({ threadId: "creator", owner: "desktop", runId: "host-route-turn" })
    try {
      expect(projectAuthoringSessions.trialRequest(f.scope)).toBeUndefined()
      const tool = createModBusinessTool({ threadId: "creator", workspace: "workspace" })
      const result = JSON.parse(
        await tool.invoke({
          action: "request_trial",
          previewId: preview.previewId,
          goal: "Read the original knowledge and validate draft.json"
        })
      )
      const original = projectAuthoringSessions.trialRequest(f.scope)
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        result: {
          trialRoute: "host",
          executed: false,
          projectTrial: {
            id: original?.id,
            draftId: original?.draftId,
            digest: original?.digest,
            origin: {
              kind: "business-assembly",
              planId: expect.any(String),
              copyId: expect.any(String)
            }
          }
        }
      })
      expect(original).toBeDefined()
      expect(result.result.projectTrial).not.toHaveProperty("projectId")
      expect(result.result).not.toHaveProperty("trial")
      expect(result.result.detailsAction).toContain("mod_authoring project_list/project_read")
      expect(f.install).not.toHaveBeenCalled()
      const draft = projectAuthoringSessions.read(f.scope, original!.draftId)
      cleanup.push(() => rm(dirname(draft.directory), { recursive: true, force: true }))
    } finally {
      releaseLocalThreadRunLease("creator", "desktop", "host-route-turn")
      setCreatorBusinessService(undefined)
      setModDevelopmentService(undefined)
    }
  })
  it("refreshes first-modularization confirmation on idle even before a publication review exists", async () => {
    const f = await fixture()
    f.busy(true)
    await f.request()
    await f.settle()
    expect(f.service.status("creator").modularization?.canConfirm).toBe(false)
    f.changed.mockClear()
    f.busy(false)
    f.idle()
    expect(f.changed).toHaveBeenCalledWith("creator")
    expect(f.service.status("creator").modularization?.canConfirm).toBe(true)
  })
  it("joins raw inspection, redacted reading, native confirmation and original preview/review with complete source retention", async () => {
    const f = await fixture()
    const { inspected, status } = await f.request()
    expect(inspected.status).toBe("candidate")
    expect(status.modularization).toMatchObject({ phase: "needs-confirmation", canConfirm: false })
    expect(existsSync(join(f.source, BUSINESS_MOD_MANIFEST))).toBe(false)
    const asset = await f.service.readRawAsset(
      "creator",
      inspected.rawInspectionId,
      "resources/service.json"
    )
    expect(asset.redacted).toBe(true)
    expect(asset.text).not.toContain("private-display-value")
    expect(await readFile(join(f.source, "resources/service.json"), "utf8")).toContain(
      "private-display-value"
    )
    await expect(
      f.service.approveModularization("creator", "workspace", status.modularization!)
    ).rejects.toThrow("CONFIRMATION_REQUIRED")
    await f.settle()
    expect(f.service.status("creator").modularization?.canConfirm).toBe(true)
    const approved = await f.service.approveModularization(
      "creator",
      "workspace",
      status.modularization!
    )
    expect(approved.modularization).toMatchObject({
      phase: "ready",
      canConfirm: false,
      inspectionId: expect.any(String)
    })
    const inspection = await f.service.inspectionPage(
      "creator",
      approved.modularization!.inspectionId!
    )
    const assets = await f.service.assets("creator", inspection.id)
    expect(assets.files.map((file) => file.path)).toContain("knowledge/policy.md")
    expect(assets.files.map((file) => file.path)).not.toContain(".env")
    const preview = await f.service.preview("creator", {
      name: "new-project-plugin",
      version: "1.0.0",
      sources: [{ inspectionId: inspection.id, modIds: ["prepare"] }]
    })
    expect(preview.valid).toBe(true)
    expect(preview.steps.map((step) => step.id)).toEqual(["prepare"])
    const review = await f.service.requestReview(
      "creator",
      preview.previewId,
      "review-turn",
      () => {}
    )
    expect(review.review?.phase).toBe("needs-approval")
    expect(f.validate).toHaveBeenCalledOnce()
    expect(f.install).not.toHaveBeenCalled()
    expect(existsSync(join(f.source, BUSINESS_MOD_MANIFEST))).toBe(false)
  })

  it("blocks original byte changes even when installed identity and approved candidate bytes are unchanged", async () => {
    const f = await fixture()
    const { status } = await f.request()
    await f.settle()
    const approved = await f.service.approveModularization(
      "creator",
      "workspace",
      status.modularization!
    )
    await write(f.source, "knowledge/policy.md", "Changed source policy\n")
    await expect(
      f.service.inspectionPage("creator", approved.modularization!.inspectionId!)
    ).rejects.toThrow("SOURCE_CHANGED")
    await expect(
      f.service.preview("creator", {
        name: "changed-source",
        version: "1.0.0",
        sources: [{ inspectionId: approved.modularization!.inspectionId!, modIds: ["prepare"] }]
      })
    ).rejects.toThrow("SOURCE_CHANGED")
    expect(f.install).not.toHaveBeenCalled()
  })

  it("does not approve a different workspace, a busy conversation or interrupted authoring turn", async () => {
    const f = await fixture()
    const { status } = await f.request()
    await f.settle()
    await expect(
      f.service.approveModularization("creator", "other-workspace", status.modularization!)
    ).rejects.toThrow("CONFIRMATION_REQUIRED")
    f.busy(true)
    await expect(
      f.service.approveModularization("creator", "workspace", status.modularization!)
    ).rejects.toThrow("BUSY")
    f.busy(false)
    await f.request()
    await f.settle("cancelled")
    expect(f.service.status("creator").modularization?.phase).toBe("cancelled")
    expect(f.service.status("creator").modularization?.canConfirm).toBe(false)
  })

  it("invalidates confirmation when the original is removed or changed before approval", async () => {
    const f = await fixture()
    const { status } = await f.request()
    await f.settle()
    f.plugins.splice(0)
    const failed = await f.service.approveModularization(
      "creator",
      "workspace",
      status.modularization!
    )
    expect(failed.modularization?.phase).toBe("failed")
    expect(failed.modularization?.inspectionId).toBeUndefined()
    expect(f.install).not.toHaveBeenCalled()
  })

  it("keeps source records but restores neither approval nor raw access after restart", async () => {
    const f = await fixture()
    const { status, inspected } = await f.request()
    await f.settle()
    f.service.close()
    const restarted = f.create()
    expect(restarted.status("creator").modularization).toBeUndefined()
    await expect(
      restarted.approveModularization("creator", "workspace", status.modularization!)
    ).rejects.toThrow("CONFIRMATION_REQUIRED")
    await expect(
      restarted.readRawAsset("creator", inspected.rawInspectionId, "knowledge/policy.md")
    ).rejects.toThrow("INSPECT_FIRST")
    expect(existsSync(join(f.source, "plugin.json"))).toBe(true)
  })
})
