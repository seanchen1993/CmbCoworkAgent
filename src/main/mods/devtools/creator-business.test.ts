import { afterEach, describe, expect, it, vi } from "vitest"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import AdmZip from "adm-zip"
import { CreatorBusinessService, setCreatorBusinessService } from "./creator-business"
import { setModDevelopmentService, type ModDevelopmentService } from "./development-service"
import { createModBusinessTool } from "../../agent/tools/mod-business-tool"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import {
  BusinessModDuplicateIdError,
  BUSINESS_MOD_DUPLICATE_ID_RECOVERY
} from "../../plugins/business-mod-diagnostics"
import { BUSINESS_MOD_MANIFEST, type BusinessModDefinition } from "../../../shared/business-mods"
import { BusinessModAssemblyService } from "../../plugins/business-mod-assembly-service"
import type { PluginMetadata } from "../../types"
import { publishDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import { BusinessDraftLimitError, businessDraftLimitHint } from "./creator-business-draft"
import type { CreatorBusinessTrials } from "./creator-business-trial"
import { parseCreatorBusinessTrialRecord } from "./creator-business-trial-record"

const roots: string[] = [],
  services: CreatorBusinessService[] = []

it("isolates an unreadable trial projection without hiding source drafts or a real publication result", async () => {
  const f = await fixture(),
    status = await f.review()
  await f.settle()
  // The original strict parser rejects the persisted payload. Only the read projection is
  // isolated; the separate trial action service keeps its own strict parser/owner checks.
  f.service.configureTrials({
    status: () =>
      parseCreatorBusinessTrialRecord("{", "invalid", {
        root: f.root,
        packagesRoot: join(f.root, "packages")
      }),
    close() {
      /* This projection seam does not own runtime resources. */
    }
  } as unknown as CreatorBusinessTrials)
  expect(f.service.status("creator")).toMatchObject({
    review: { planId: status.review!.planId },
    drafts: [{ id: f.draft.id }],
    trialDiagnostic: expect.any(String)
  })
  const installed = await f.service.approve("creator", "workspace", status.review!)
  expect(f.install).toHaveBeenCalledOnce()
  expect(installed.review?.phase).toBe("installed")
  expect(installed.trial).toBeUndefined()
  expect(installed.trialDiagnostic).toEqual(expect.any(String))
})
afterEach(async () => {
  setCreatorBusinessService(undefined)
  setModDevelopmentService(undefined)
  releaseLocalThreadRunLease("creator", "desktop", "duplicate-diagnostic-turn")
  for (const service of services.splice(0)) service.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(["source", "Source"])(
  "preserves real assembly duplicate rejection and returns a repairable tool diagnostic: %s",
  async (duplicateId) => {
    const f = await fixture()
    const duplicate = mod(duplicateId, "duplicate-source")
    const draft = f.service.save("creator", {
      id: "duplicate-source",
      name: "Independent source",
      revision: 0,
      baseInspectionId: f.inspected.id,
      modules: [duplicate],
      files: [
        {
          path: duplicate.skill.entry,
          text: "Produce actual evidence; do not replace the existing source."
        }
      ]
    })
    const request = {
      name: "Duplicate diagnostic package",
      version: "1.0.0",
      sources: [{ inspectionId: f.inspected.id, modIds: ["source"] }],
      drafts: [{ id: draft.id, revision: draft.revision, modIds: [duplicateId] }]
    }
    await expect(f.service.preview("creator", request)).rejects.toBeInstanceOf(
      BusinessModDuplicateIdError
    )
    await expect(f.service.preview("creator", request)).rejects.toThrow(
      `来源包含重复业务 Mod 标识：${duplicateId}`
    )
    setCreatorBusinessService(f.service)
    setModDevelopmentService({
      isCreatorMode: () => true,
      captureCreatorMode: () => () => {},
      claimAuthoringBudget: () => {}
    } as unknown as ModDevelopmentService)
    claimLocalThreadRunLease({
      threadId: "creator",
      owner: "desktop",
      runId: "duplicate-diagnostic-turn"
    })
    const tool = createModBusinessTool({ threadId: "creator", workspace: f.scope.workspace })
    const result = JSON.parse(await tool.invoke({ action: "preview", ...request }))
    expect(result).toMatchObject({
      ok: false,
      error: "BUSINESS_MOD_DUPLICATE_ID",
      modId: duplicateId,
      recovery: BUSINESS_MOD_DUPLICATE_ID_RECOVERY
    })
    expect(result).not.toHaveProperty("previewId")
    expect(f.service.status("creator").review).toBeUndefined()
    expect(f.install).not.toHaveBeenCalled()
    expect(f.service.read("creator", draft.id).digest).toBe(draft.digest)
    // An explicit corrected selection still goes through the original assembler, without
    // silently deleting/overwriting either draft or bypassing its source/runtime bytes.
    const fixed = await f.preview()
    expect(fixed.valid).toBe(true)
    expect(fixed.steps.map((step) => step.id)).toEqual(["source", "user.quality"])
    expect(fixed.files.find((file) => file.path === "board_core/runtime.py")).toBeDefined()
    expect(f.install).not.toHaveBeenCalled()
  }
)
async function write(root: string, path: string, text: unknown) {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, typeof text === "string" ? text : JSON.stringify(text))
}
function mod(id: string, skill: string, input?: string): BusinessModDefinition {
  return {
    id,
    title: id,
    node: {
      id,
      skill,
      checkpoints: [`${id}_in_progress`, `${id}_done`],
      validators: [],
      guards: [],
      artifacts: {
        inputs: input ? [{ id: "input", path: input, required: true }] : [],
        outputs: [{ id: "out", path: `${id}.json`, required: true }]
      }
    },
    skill: { entry: `skills/${skill}/SKILL.md`, resources: [] },
    resources: [],
    dependencies: { required: input ? ["source"] : [], advisory: [] },
    checks: { validators: [], guards: [] }
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "creator-business-"))
  roots.push(root)
  const directory = join(root, "original"),
    base = mod("source", "source")
  await write(directory, "plugin.json", { name: "Original", version: "1.0.0" })
  await write(directory, BUSINESS_MOD_MANIFEST, {
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernel: {
      id: "fixture.kernel",
      version: "1.0.0",
      resources: ["board_core/runtime.py"],
      boardConfigPath: "board_core/board_config.json"
    },
    modules: [base]
  })
  await write(directory, "board_core/runtime.py", "# reviewed original business runtime")
  await write(directory, "board_core/board_config.json", { workflow: { nodes: [base.node] } })
  await write(
    directory,
    "skills/source/SKILL.md",
    "Produce source.json without skipping original validation."
  )
  await write(directory, "credentials.json", { secret: "must-never-enter-model-or-package" })
  const plugins = [
    {
      id: "original",
      name: "Original",
      version: "1.0.0",
      path: directory,
      enabled: true,
      updatedAt: "first",
      businessModCount: 1
    }
  ] as PluginMetadata[]
  const install = vi.fn(
    async (
      source: string,
      name: string,
      id: string,
      guard: () => void,
      verify: (path: string) => Promise<void>
    ) => {
      const target = join(root, "installed", id)
      await cp(source, target, { recursive: true })
      await verify(target)
      guard()
      plugins.push({ id, name, version: "1.0.0", path: target, enabled: true } as PluginMetadata)
      return { success: true }
    }
  )
  const assembly = new BusinessModAssemblyService(join(root, "assemblies"), {
    plugins: () => plugins,
    validatePackage: vi.fn(async () => {}),
    install,
    invalidate: () => {}
  })
  const values = new Map<string, string>()
  const settings = {
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    compareAndSetSetting: (key: string, before: string | undefined, value: string) => {
      if (values.get(key) !== before) return false
      values.set(key, value)
      return true
    }
  }
  let token = "first",
    busy = false
  const scope = {
    workspace: "workspace",
    threadId: "creator",
    incarnation: { token, legacyCreatedAt: 1 }
  }
  const context = () => {
    const captured = token
    return {
      scope: { ...scope, incarnation: { ...scope.incarnation, token } },
      assertCurrent: () => {
        if (captured !== token) throw Error("BUSINESS_SCOPE_CHANGED")
      }
    }
  }
  const changed = vi.fn()
  const deps = {
    root: join(root, "drafts"),
    settings,
    assembly,
    plugins: () => plugins,
    context,
    readContext: context,
    busy: () => busy,
    changed
  }
  const create = () => {
    const service = new CreatorBusinessService(deps)
    services.push(service)
    return service
  }
  const service = create()
  const inspected = await service.inspect("creator", "original")
  const quality = mod("user.quality", "quality", "source.json")
  quality.resources = ["mods/business/user.quality/check.py"]
  const sourceInput = {
    id: "my-quality",
    name: "My quality",
    revision: 0,
    baseInspectionId: inspected.id,
    modules: [quality],
    files: [
      {
        path: quality.skill.entry,
        text: "Read source.json and write real quality evidence to user.quality.json."
      },
      {
        path: quality.resources[0],
        text: "def validate(context):\n    raise ValueError('missing required evidence')\n"
      }
    ]
  }
  const draft = service.save("creator", sourceInput)
  const preview = () =>
    service.preview("creator", {
      name: "Created quality project",
      version: "1.0.0",
      sources: [{ inspectionId: inspected.id, modIds: ["source"] }],
      drafts: [{ id: draft.id, revision: draft.revision, modIds: ["user.quality"] }]
    })
  const review = async () => {
    const prepared = await preview()
    return service.requestReview("creator", prepared.previewId, "turn", () => {})
  }
  const settle = async () => {
    publishDevelopmentTurnSettlement({
      threadId: "creator",
      turnId: "turn",
      incarnation: scope.incarnation,
      outcome: "completed"
    })
    await Promise.resolve()
  }
  return {
    root,
    directory,
    service,
    create,
    settings,
    values,
    inspected,
    sourceInput,
    draft,
    preview,
    review,
    settle,
    install,
    plugins,
    assembly,
    scope,
    busy: (value: boolean) => {
      busy = value
    },
    replace: () => {
      token = "replacement"
    }
  }
}

describe("native current-chat business Mod authoring", () => {
  it("keeps legacy unknown outcomes without a durable effect identity unknown rather than guessing by name", async () => {
    const f = await fixture(),
      ready = await f.review()
    const entry = [...f.values.entries()].find(([key]) =>
      key.startsWith("mods-creator-business-review-v1:")
    )!
    const record = JSON.parse(entry[1])
    record.review.phase = "unknown"
    delete record.effect
    f.values.set(entry[0], JSON.stringify(record))
    const result = await f.service.reconcile("creator", "workspace", {
      planId: ready.review!.planId,
      digest: ready.review!.digest
    })
    expect(result.review).toMatchObject({
      phase: "unknown",
      canConfirm: false,
      reconciliation: { outcome: "unknown", reason: "BUSINESS_CREATOR_EFFECT_IDENTITY_MISSING" }
    })
    expect(f.install).not.toHaveBeenCalled()
  })
  it("reconciles an interrupted original installation by its journaled UUID and bytes without replay or reapproval", async () => {
    const f = await fixture(),
      ready = await f.review()
    await f.settle()
    const original = f.assembly.install.bind(f.assembly)
    const attempt = vi.spyOn(f.assembly, "install").mockImplementation(async (...args) => {
      await original(...args)
      throw Error("lost reply after original installer committed")
    })
    const input = { planId: ready.review!.planId, digest: ready.review!.digest }
    expect((await f.service.approve("creator", "workspace", input)).review!.phase).toBe("unknown")
    f.service.close()
    const restored = f.create()
    const reconciled = await restored.reconcile("creator", "workspace", input)
    expect(reconciled.review).toMatchObject({
      phase: "installed",
      canConfirm: false,
      reconciliation: { outcome: "installed" },
      pluginId: f.plugins.at(-1)!.id
    })
    expect(f.install).toHaveBeenCalledOnce()
    expect(attempt).toHaveBeenCalledOnce()
    await expect(restored.approve("creator", "workspace", input)).rejects.toThrow("REVIEW_REQUIRED")
    await expect(restored.reconcile("creator", "another-workspace", input)).rejects.toThrow(
      "REVIEW_CHANGED"
    )
  })
  it("keeps unknown when only the name matches or installed bytes change, and never executes installer during readback", async () => {
    const f = await fixture(),
      ready = await f.review()
    await f.settle()
    const original = f.assembly.install.bind(f.assembly)
    vi.spyOn(f.assembly, "install").mockImplementation(async (...args) => {
      await original(...args)
      throw Error("lost commit reply")
    })
    const input = { planId: ready.review!.planId, digest: ready.review!.digest }
    await f.service.approve("creator", "workspace", input)
    const installed = f.plugins.at(-1)!,
      id = installed.id
    installed.id = "another-uuid"
    expect((await f.service.reconcile("creator", "workspace", input)).review).toMatchObject({
      phase: "unknown",
      reconciliation: { outcome: "unknown" }
    })
    installed.id = id
    await writeFile(join(installed.path, "skills/source/SKILL.md"), "modified")
    expect((await f.service.reconcile("creator", "workspace", input)).review!.phase).toBe("unknown")
    expect(f.install).toHaveBeenCalledOnce()
    await expect(
      f.service.requestReview("creator", (await f.preview()).previewId, "turn", () => {})
    ).rejects.toThrow("OUTCOME_UNCONFIRMED")
  })
  it("reconciles exact exported ZIP bytes after restart without exporting again, even after source changes", async () => {
    const f = await fixture(),
      ready = await f.review()
    await f.settle()
    const original = f.assembly.export.bind(f.assembly)
    const exportCall = vi.spyOn(f.assembly, "export").mockImplementation(async (...args) => {
      await original(...args)
      throw Error("lost ZIP reply")
    })
    const input = { planId: ready.review!.planId, digest: ready.review!.digest },
      output = join(f.root, "exact.zip")
    expect(
      (await f.service.exportTrusted("creator", "workspace", input, output)).review!.phase
    ).toBe("unknown")
    const bytes = await readFile(output)
    await writeFile(join(f.directory, "skills/source/SKILL.md"), "source changed after export")
    f.service.close()
    const restored = f.create()
    const result = await restored.reconcile("creator", "workspace", input)
    expect(result.review).toMatchObject({
      phase: "exported",
      output,
      canConfirm: false,
      reconciliation: { outcome: "exported" }
    })
    expect(exportCall).toHaveBeenCalledOnce()
    expect(await readFile(output)).toEqual(bytes)
    expect(f.install).not.toHaveBeenCalled()
  })
  it("rejects a modified ZIP and stale/scope-lost readback without replaying its operation", async () => {
    const f = await fixture(),
      ready = await f.review()
    await f.settle()
    const original = f.assembly.export.bind(f.assembly)
    vi.spyOn(f.assembly, "export").mockImplementation(async (...args) => {
      await original(...args)
      throw Error("lost ZIP reply")
    })
    const input = { planId: ready.review!.planId, digest: ready.review!.digest },
      output = join(f.root, "changed.zip")
    await f.service.exportTrusted("creator", "workspace", input, output)
    const bytes = await readFile(output)
    bytes[bytes.length - 1] ^= 1
    await writeFile(output, bytes)
    expect((await f.service.reconcile("creator", "workspace", input)).review!.phase).toBe("unknown")
    await expect(
      f.service.reconcile("creator", "workspace", { ...input, digest: "a".repeat(64) })
    ).rejects.toThrow("REVIEW_CHANGED")
    f.replace()
    await expect(f.service.reconcile("creator", "workspace", input)).rejects.toThrow(
      "REVIEW_CHANGED"
    )
  })
  it("keeps original knowledge configuration while redacting literal credentials from model source reads", async () => {
    const f = await fixture()
    const path = "board_core/board_config.json"
    const board = JSON.parse(await readFile(join(f.directory, path), "utf8"))
    board.knowledge_config = {
      leanToken: "literal-local-secret",
      apiToken: "${env:KNOWLEDGE_TOKEN}"
    }
    await write(f.directory, path, board)
    const inspected = await f.service.inspect("creator", "original")
    const asset = await f.service.readAsset("creator", inspected.id, path)
    expect(asset).toMatchObject({ redacted: true, originalPreserved: true })
    expect(asset.text).not.toContain("literal-local-secret")
    expect(asset.text).toContain("${env:KNOWLEDGE_TOKEN}")
    expect(await readFile(join(f.directory, path), "utf8")).toContain("literal-local-secret")
  })
  it("reads exact individual contracts within the inspected source scope and rejects changed sources", async () => {
    const f = await fixture()
    expect(await f.service.inspectionPage("creator", f.inspected.id)).toMatchObject({
      id: f.inspected.id
    })
    expect(await f.service.readMod("creator", f.inspected.id, "source")).toMatchObject({
      mod: f.inspected.catalog.modules[0],
      sourceDigest: f.inspected.sourceDigest
    })
    await expect(f.service.readMod("creator", f.inspected.id, "not-declared")).rejects.toThrow(
      "BUSINESS_CREATOR_MOD_UNAVAILABLE"
    )
    await write(f.directory, "board_core/runtime.py", "# source changed")
    await expect(f.service.readMod("creator", f.inspected.id, "source")).rejects.toThrow(
      "BUSINESS_CREATOR_SOURCE_CHANGED"
    )
  })
  it("creates persistent real Python Mods, composes original resources, then installs and exports only after trusted confirmation", async () => {
    const f = await fixture()
    expect(f.service.catalog("creator").drafts).toMatchObject([{ id: "my-quality", revision: 1 }])
    expect(f.service.read("creator", "my-quality").baseSource).toMatchObject({
      pluginId: "original",
      digest: f.inspected.sourceDigest
    })
    expect(
      await f.service.readAsset("creator", f.inspected.id, "board_core/runtime.py")
    ).toMatchObject({ text: "# reviewed original business runtime" })
    const assets = await f.service.assets("creator", f.inspected.id)
    expect(assets.files.map((file) => file.path)).toContain("board_core/runtime.py")
    expect(assets.files.some((file) => file.path === "credentials.json")).toBe(false)
    await expect(
      f.service.readAsset("creator", f.inspected.id, "credentials.json")
    ).rejects.toThrow("资源路径无效")
    const prepared = await f.review(),
      input = { planId: prepared.review!.planId, digest: prepared.review!.digest }
    expect(prepared.review).toMatchObject({ phase: "needs-approval", canConfirm: false })
    expect(prepared.review!.steps.map((step) => step.id)).toEqual(["source", "user.quality"])
    expect(f.install).not.toHaveBeenCalled()
    await expect(f.service.approve("creator", "workspace", input)).rejects.toThrow(
      "BUSINESS_CREATOR_REVIEW_REQUIRED"
    )
    await f.settle()
    expect(f.service.status("creator").review?.canConfirm).toBe(true)
    const installed = await f.service.approve("creator", "workspace", input)
    expect(installed.review).toMatchObject({ phase: "installed", canConfirm: true })
    expect(f.install).toHaveBeenCalledTimes(1)
    const plugin = f.plugins.find((item) => item.id === installed.review?.pluginId)!
    expect(
      await readFile(join(plugin.path, "mods/business/user.quality/check.py"), "utf8")
    ).toContain("raise ValueError")
    const output = join(f.root, "created.zip")
    expect(
      (await f.service.exportTrusted("creator", "workspace", input, output)).review
    ).toMatchObject({ phase: "installed", output })
    const zip = new AdmZip(await readFile(output))
    expect(zip.readAsText("board_core/runtime.py")).toBe("# reviewed original business runtime")
    expect(zip.readAsText("mods/business/user.quality/check.py")).toContain(
      "missing required evidence"
    )
    expect(zip.getEntries().some((entry) => entry.entryName === "credentials.json")).toBe(false)
  })
  it("restores author source after restart but requires a fresh native review", async () => {
    const f = await fixture()
    await f.review()
    f.service.close()
    const restored = f.create(),
      status = restored.status("creator")
    expect(status.drafts).toMatchObject([{ id: "my-quality", revision: 1 }])
    expect(status.review).toMatchObject({ phase: "needs-review", canConfirm: false })
    await expect(restored.approve("creator", "workspace", status.review!)).rejects.toThrow(
      "BUSINESS_CREATOR_REVIEW_REQUIRED"
    )
    expect(f.install).not.toHaveBeenCalled()
    f.replace()
    expect(restored.status("creator").drafts).toEqual([])
  })
  it("allows dialogue changes before installation without renaming the output or overwriting old candidate bytes", async () => {
    const f = await fixture(),
      previous = await f.review()
    const changed = f.service.save("creator", {
      ...f.sourceInput,
      revision: 1,
      files: f.sourceInput.files.map((file) =>
        file.path.endsWith("check.py")
          ? {
              ...file,
              text: "def validate(context):\n    raise ValueError('evidence still required')\n"
            }
          : file
      )
    })
    const preview = await f.service.preview("creator", {
      name: "Created quality project",
      version: "1.0.0",
      sources: [{ inspectionId: f.inspected.id, modIds: ["source"] }],
      drafts: [{ id: changed.id, revision: changed.revision, modIds: ["user.quality"] }]
    })
    const next = await f.service.requestReview("creator", preview.previewId, "turn", () => {})
    expect(next.review!.copyId).not.toBe(previous.review!.copyId)
    expect(next.review!.digest).not.toBe(previous.review!.digest)
    expect(next.review!.name).toBe(previous.review!.name)
    await f.settle()
    await expect(f.service.approve("creator", "workspace", previous.review!)).rejects.toThrow(
      "BUSINESS_CREATOR_REVIEW_CHANGED"
    )
    expect(f.install).not.toHaveBeenCalled()
    expect((await f.service.approve("creator", "workspace", next.review!)).review?.phase).toBe(
      "installed"
    )
    expect(f.install).toHaveBeenCalledTimes(1)
  })
  it("exports an installed same-name revision through the original ZIP update path without another installation", async () => {
    const f = await fixture(),
      first = await f.review()
    await f.settle()
    const installed = await f.service.approve("creator", "workspace", first.review!)
    const pluginId = installed.review!.pluginId!,
      original = f.plugins.find((item) => item.id === pluginId)!
    const changed = f.service.save("creator", {
      ...f.sourceInput,
      revision: 1,
      files: f.sourceInput.files.map((file) =>
        file.path.endsWith("check.py")
          ? { ...file, text: "def validate(context):\n    raise ValueError('new evidence')\n" }
          : file
      )
    })
    const preview = await f.service.preview("creator", {
      name: first.review!.name,
      version: "1.0.1",
      sources: [{ inspectionId: f.inspected.id, modIds: ["source"] }],
      drafts: [{ id: changed.id, revision: changed.revision, modIds: ["user.quality"] }]
    })
    const next = await f.service.requestReview("creator", preview.previewId, "turn", () => {})
    await f.settle()
    expect(next.review).toMatchObject({ exportOnly: true, phase: "needs-approval" })
    await expect(f.service.approve("creator", "workspace", next.review!)).rejects.toThrow(
      "BUSINESS_MOD_NATIVE_ZIP_UPDATE_REQUIRED"
    )
    const output = join(f.root, "update.zip")
    expect(
      (await f.service.exportTrusted("creator", "workspace", next.review!, output)).review
    ).toMatchObject({ phase: "exported", exportOnly: true })
    expect(new AdmZip(output).readAsText("mods/business/user.quality/check.py")).toContain(
      "new evidence"
    )
    expect(
      await readFile(join(original.path, "mods/business/user.quality/check.py"), "utf8")
    ).toContain("missing required evidence")
    expect(f.plugins.filter((item) => item.name === original.name).map((item) => item.id)).toEqual([
      pluginId
    ])
    expect(f.install).toHaveBeenCalledTimes(1)
  })
  it("keeps existing ZIP files intact and never replays an uncertain export across restart", async () => {
    const f = await fixture(),
      ready = await f.review()
    await f.settle()
    const output = join(f.root, "retained.zip")
    await writeFile(output, "retained original bytes")
    expect(
      (await f.service.exportTrusted("creator", "workspace", ready.review!, output)).review
    ).toMatchObject({ phase: "needs-approval", error: "BUSINESS_CREATOR_EXPORT_EXISTS" })
    expect(await readFile(output, "utf8")).toBe("retained original bytes")
    const originalExport = vi.spyOn(f.assembly, "export").mockImplementationOnce(async () => {
      await writeFile(join(f.root, "uncertain.zip"), "effect happened")
      throw Error("uncertain IO")
    })
    expect(
      (
        await f.service.exportTrusted(
          "creator",
          "workspace",
          ready.review!,
          join(f.root, "uncertain.zip")
        )
      ).review
    ).toMatchObject({ phase: "unknown", canConfirm: false })
    f.service.close()
    const restored = f.create()
    await expect(
      restored.exportTrusted("creator", "workspace", ready.review!, join(f.root, "replayed.zip"))
    ).rejects.toThrow("BUSINESS_CREATOR_REVIEW_REQUIRED")
    expect(originalExport).toHaveBeenCalledTimes(1)
    await expect(
      restored.requestReview("creator", "00000000-0000-4000-8000-000000000000", "turn", () => {})
    ).rejects.toThrow("BUSINESS_CREATOR_OUTCOME_UNCONFIRMED")
  })
  it("rejects changed source/draft identities before publishing and never reinstalls unknown writes", async () => {
    const f = await fixture()
    const ready = await f.review()
    await f.settle()
    f.plugins[0].updatedAt = "changed"
    expect((await f.service.approve("creator", "workspace", ready.review!)).review).toMatchObject({
      phase: "failed",
      error: "BUSINESS_CREATOR_INPUT_CHANGED"
    })
    expect(f.install).not.toHaveBeenCalled()
    f.plugins[0].updatedAt = "first"
    const next = await f.review()
    await f.settle()
    f.install.mockImplementationOnce(async () => {
      throw Error("uncertain original transaction")
    })
    expect((await f.service.approve("creator", "workspace", next.review!)).review).toMatchObject({
      phase: "unknown",
      canConfirm: false
    })
    await expect(f.service.approve("creator", "workspace", next.review!)).rejects.toThrow(
      "BUSINESS_CREATOR_REVIEW_REQUIRED"
    )
    await expect(f.review()).rejects.toThrow("BUSINESS_CREATOR_OUTCOME_UNCONFIRMED")
    expect(f.install).toHaveBeenCalledTimes(1)
  })
  it("rejects kernel-file replacement, arbitrary paths, stale revisions and non-declared dependencies", async () => {
    const f = await fixture()
    expect(() =>
      f.service.save("creator", {
        ...f.sourceInput,
        revision: 1,
        files: [...f.sourceInput.files, { path: "board_core/runtime.py", text: "bypass" }]
      })
    ).toThrow("BUSINESS_DRAFT_NAMESPACE")
    expect(() => f.service.save("creator", { ...f.sourceInput, revision: 0 })).toThrow(
      "BUSINESS_DRAFT_REVISION_CHANGED"
    )
    expect(() =>
      f.service.save("creator", {
        ...f.sourceInput,
        revision: 1,
        files: [{ path: "../escape.py", text: "bypass" }]
      })
    ).toThrow("资源路径无效")
    await expect(
      f.service.preview("creator", {
        name: "Unbound",
        version: "1.0.0",
        sources: [],
        drafts: [{ id: f.draft.id, revision: 1, modIds: ["user.quality"] }]
      })
    ).rejects.toThrow("BUSINESS_DRAFT_BASE_CHANGED")
  })
  it("preserves source at draft limits and allows an explicit new draft without renaming its Mods", async () => {
    const f = await fixture()
    for (let revision = 1; revision < 8; revision++)
      f.service.save("creator", { ...f.sourceInput, revision })
    let limit: unknown
    try {
      f.service.save("creator", { ...f.sourceInput, revision: 8 })
    } catch (error) {
      limit = error
    }
    expect(limit).toBeInstanceOf(BusinessDraftLimitError)
    expect(businessDraftLimitHint((limit as BusinessDraftLimitError).reason)).toContain("read")
    const retained = f.service.read("creator", "my-quality")
    expect(retained.revision).toBe(8)
    expect(retained.files).toEqual(expect.arrayContaining(f.sourceInput.files))
    const next = f.service.save("creator", { ...f.sourceInput, id: "next-quality", revision: 0 })
    expect(next.catalog.modules[0].id).toBe("user.quality")
    expect(next.files).toEqual(retained.files)
    for (const id of ["third-quality", "fourth-quality"])
      f.service.save("creator", { ...f.sourceInput, id, revision: 0 })
    expect(() =>
      f.service.save("creator", { ...f.sourceInput, id: "fifth-quality", revision: 0 })
    ).toThrow("BUSINESS_DRAFT_LIMIT")
    expect(f.service.read("creator", "my-quality").revision).toBe(8)
    expect(f.install).not.toHaveBeenCalled()
  })
  it("does not grant or install on interrupted turns, busy windows, or a mismatched digest", async () => {
    const f = await fixture(),
      prepared = await f.review()
    await f.settle()
    f.busy(true)
    await expect(f.service.approve("creator", "workspace", prepared.review!)).rejects.toThrow(
      "BUSINESS_CREATOR_BUSY"
    )
    f.busy(false)
    await expect(
      f.service.approve("creator", "workspace", { ...prepared.review!, digest: "f".repeat(64) })
    ).rejects.toThrow("BUSINESS_CREATOR_REVIEW_CHANGED")
    publishDevelopmentTurnSettlement({
      threadId: "creator",
      turnId: "turn",
      incarnation: f.scope.incarnation,
      outcome: "cancelled"
    })
    await Promise.resolve()
    await expect(f.service.approve("creator", "workspace", prepared.review!)).rejects.toThrow(
      "BUSINESS_CREATOR_REVIEW_REQUIRED"
    )
    expect(f.install).not.toHaveBeenCalled()
  })
})
