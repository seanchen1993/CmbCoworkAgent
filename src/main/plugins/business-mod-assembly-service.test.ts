import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import AdmZip from "adm-zip"
import { afterEach, expect, it, vi } from "vitest"
import { BUSINESS_MOD_ASSEMBLY, BUSINESS_MOD_MANIFEST } from "../../shared/business-mods"
import type { BusinessModCatalog } from "../../shared/business-mods"
import { BusinessModAssemblyService } from "./business-mod-assembly-service"
import { snapshotDerivationSource } from "./derivation-source"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { portableBusinessModFiles } from "./business-mod-portable-source"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const guard = () => {
  /* Fixture keeps its host owner current. */
}
async function write(root: string, path: string, value: unknown) {
  const target = join(root, path)
  const { dirname } = await import("node:path")
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, typeof value === "string" ? value : JSON.stringify(value))
}
function module(id: string, skill: string, input?: string, output = id + ".md") {
  return {
    id,
    title: id,
    node: {
      id,
      skill,
      label: id,
      group: "Business",
      order: id === "prd" ? 10 : 20,
      checkpoints: [id + "_in_progress", id + "_done"],
      validators: [],
      guards: [],
      artifacts: {
        inputs: input ? [{ id: "input", path: input, required: true }] : [],
        outputs: [{ id: "output", path: output, required: true }]
      }
    },
    skill: { entry: `skills/${skill}/SKILL.md`, resources: [`skills/${skill}`] },
    resources: [] as string[],
    dependencies: { required: [] as string[], advisory: [] as string[] },
    checks: { validators: [] as string[], guards: [] as string[] }
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "business-mod-assembly-"))
  roots.push(root)
  const source = join(root, "source"),
    user = join(root, "user")
  const prd = module("prd", "make-prd", undefined, "PRD.md")
  const specs = module("specs", "make-specs", "PRD.md", "SPECS.md")
  specs.dependencies.required = ["prd"]
  const code = module("code", "make-code", "SPECS.md", "CODE.md")
  const catalog: BusinessModCatalog = {
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernel: {
      id: "autobiz.python-kernel",
      version: "1.0.0",
      boardConfigPath: "board_core/board_config.json",
      resources: ["hooks/check.py", "hooks/hooks.json"],
      pluginFields: { hooks: "hooks/hooks.json" }
    },
    modules: [prd, specs, code]
  }
  await write(source, "plugin.json", { name: "original", version: "1.0.0" })
  await write(source, BUSINESS_MOD_MANIFEST, catalog)
  await write(source, "board_core/board_config.json", {
    apiVersion: 1,
    workflow: {
      templates: { custom: { kind: "custom", requiredNodes: ["code"] } },
      nodes: catalog.modules.map((mod) => mod.node)
    }
  })
  await write(source, "hooks/check.py", "# One shared original checker\n")
  await write(source, "hooks/hooks.json", { PreToolUse: [] })
  for (const mod of catalog.modules)
    await write(source, mod.skill.entry, `# Real implementation ${mod.id}`)
  await write(source, "unselected-business.txt", "Never copy entire source")
  await write(source, ".env", "must-not-read-or-copy")
  const quality = module("user.quality", "my-quality", "SPECS.md", "QUALITY.md")
  quality.resources = ["mods/business/user.quality/check.py"]
  quality.dependencies.required = ["specs"]
  quality.checks.validators = ["business:user.quality"]
  Object.assign(quality.node, {
    validators: quality.checks.validators,
    validatorBindings: {
      "business:user.quality": {
        path: "mods/business/user.quality/check.py",
        function: "validate"
      }
    }
  })
  await write(user, "plugin.json", { name: "my-source", version: "1.0.0" })
  await write(user, BUSINESS_MOD_MANIFEST, {
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernelRef: { id: "autobiz.python-kernel", version: "1.0.0" },
    modules: [quality]
  })
  await write(user, quality.skill.entry, "# My real quality implementation")
  await write(user, quality.resources[0], "def validate(context):\n    return context\n")
  const plugins: Array<{ id: string; name: string }> = []
  const invalidate = vi.fn()
  const validatePackage = vi.fn(async () => {})
  const install = vi.fn(
    async (
      directory: string,
      name: string,
      pluginId: string,
      assertCurrent: () => void,
      verify: (directory: string) => Promise<void>
    ) => {
      const destination = join(root, "installed", pluginId)
      await cp(directory, destination, { recursive: true })
      await verify(destination)
      assertCurrent()
      plugins.push({ id: pluginId, name })
      return { success: true }
    }
  )
  const service = new BusinessModAssemblyService(join(root, "work"), {
    plugins: () =>
      plugins as ReturnType<
        import("./derivation-service").DerivationServiceDependencies["plugins"]
      >,
    validatePackage,
    install,
    invalidate
  })
  const inspected = await service.inspect(source, "owner", guard)
  const custom = await service.inspect(user, "owner", guard)
  const request = {
    name: "my-composed-plugin",
    version: "1.0.0",
    sources: [
      { inspectionId: inspected.id, modIds: ["specs"] },
      { inspectionId: custom.id, modIds: ["user.quality"] }
    ]
  }
  return {
    root,
    source,
    user,
    service,
    inspected,
    custom,
    request,
    catalog,
    validatePackage,
    install,
    invalidate
  }
}

it("reports dynamic behavior changes and missing knowledge bindings instead of claiming complete equivalence", async () => {
  const f = await fixture()
  const path = join(f.source, "board_core/board_config.json")
  const board = JSON.parse(await readFile(path, "utf8"))
  board.workflow.dynamicStages = [{ id: "conditional-detail", nodes: [] }]
  board.knowledge_config = { nextAction: { slashSkill: "knowledge-sync" } }
  board.inspectCommands = { [process.platform]: { knowledge_path: "${pluginPath}/sys" } }
  await write(f.source, "board_core/board_config.json", board)
  const inspected = await f.service.inspect(f.source, "owner", guard)
  const request = { ...f.request, sources: [
    { inspectionId: inspected.id, modIds: ["specs"] },
    { inspectionId: f.custom.id, modIds: ["user.quality"] }
  ] }
  const preview = await f.service.preview("owner", request, guard)
  expect(preview.diagnostics).toEqual(expect.arrayContaining([
    expect.stringContaining("行为差异"), expect.stringContaining("knowledge-sync"),
    expect.stringContaining("外部知识待绑定")
  ]))
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(board)
  expect(preview.valid).toBe(false)
  await expect(f.service.create("owner", preview.previewId, randomUUID(), guard))
    .rejects.toThrow("未解决的依赖或行为差异")
  const accepted = await f.service.preview("owner", { ...request, acceptFixedWorkflow: true }, guard)
  expect(accepted.valid).toBe(false) // Acknowledging fixed steps cannot provide the missing Skill.
})

it("requires an explicit fixed-workflow choice bound to the inspected source before generating", async () => {
  const f = await fixture()
  const path = join(f.source, "board_core/board_config.json")
  const board = JSON.parse(await readFile(path, "utf8"))
  board.workflow.dynamicStages = [{ id: "conditional", nodes: ["code"] }]
  await write(f.source, "board_core/board_config.json", board)
  const inspected = await f.service.inspect(f.source, "owner", guard)
  const request = { ...f.request, sources: [
    { inspectionId: inspected.id, modIds: ["specs"] }, f.request.sources[1]
  ] }
  const blocked = await f.service.preview("owner", request, guard)
  expect(blocked).toMatchObject({ valid: false, requiresFixedWorkflowAcknowledgement: true })
  await expect(f.service.create("owner", blocked.previewId, randomUUID(), guard)).rejects.toThrow("行为差异")
  const accepted = await f.service.preview("owner", { ...request, acceptFixedWorkflow: true }, guard)
  expect(accepted.valid).toBe(true)
  expect(await f.service.create("owner", accepted.previewId, randomUUID(), guard))
    .toMatchObject({ status: "created" })
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(board)
})

it("materializes only selected implementations, one kernel and a user Mod as a new independent plugin", async () => {
  const f = await fixture()
  const preview = await f.service.preview("owner", f.request, guard)
  expect(preview.steps.map((step) => [step.id, step.added ?? false])).toEqual([
    ["prd", true],
    ["specs", false],
    ["user.quality", false]
  ])
  expect(preview.files.filter((file) => file.path === "hooks/check.py")).toHaveLength(1)
  expect(
    preview.files.some(
      (file) =>
        file.path.includes("make-code") ||
        file.path.includes("unselected-business") ||
        file.path === ".env"
    )
  ).toBe(false)
  const copy = await f.service.create("owner", preview.previewId, randomUUID(), guard)
  const source = join(f.root, "work", copy.copyId, "source")
  const board = JSON.parse(await readFile(join(source, "board_core/board_config.json"), "utf8"))
  expect(board.workflow.nodes.map((node: { id: string }) => node.id)).toEqual([
    "prd",
    "specs",
    "user.quality"
  ])
  expect(board.workflow.checkpoints.transitions["user.quality_done"]).toEqual([])
  expect(board.workflow.templates.custom).toMatchObject({ kind: "custom", requiredNodes: [] })
  expect(JSON.parse(await readFile(join(source, "plugin.json"), "utf8")).name).toBe(f.request.name)
  const lock = JSON.parse(await readFile(join(source, BUSINESS_MOD_ASSEMBLY), "utf8"))
  expect(lock.kernel.files).toHaveLength(2)
  expect(lock.sources.map((item: { name: string }) => item.name)).toEqual(["original", "my-source"])
  expect(JSON.stringify(lock)).not.toMatch(/pluginId|profileId/)
  expect((await snapshotDerivationSource(source)).digest).toBe(preview.digest)
  await f.service.check("owner", copy.copyId, copy.digest, guard)
  const installed = await f.service.install("owner", copy.copyId, copy.digest, guard)
  expect(installed.status).toBe("installed")
  expect(installed.pluginId).toMatch(/^[a-f0-9-]{36}$/)
  expect(f.install).toHaveBeenCalledOnce()
  expect(f.invalidate).toHaveBeenCalledOnce()
  await expect(f.service.install("owner", copy.copyId, "f".repeat(64), guard)).rejects.toThrow(
    "安装目标版本已变化"
  )
  expect(await f.service.install("owner", copy.copyId, copy.digest, guard)).toEqual(installed)
  expect(f.install).toHaveBeenCalledOnce()
  expect((await f.service.check("owner", copy.copyId, copy.digest, guard)).status).toBe("installed")
  const output = join(f.root, "new.zip")
  await f.service.export("owner", copy.copyId, copy.digest, output, guard)
  const zip = new AdmZip(await readFile(output))
  expect(zip.getEntries().filter((entry) => entry.entryName === "hooks/check.py")).toHaveLength(1)
  expect(zip.readAsText("plugin.json")).toContain(f.request.name)
  await expect(f.service.export("owner", copy.copyId, copy.digest, output, guard)).rejects.toThrow()
})

it("checks source CAS and ownership before generating, without overwriting an existing plugin", async () => {
  const f = await fixture()
  await expect(f.service.preview("other", f.request, guard)).rejects.toThrow("当前会话")
  const preview = await f.service.preview("owner", f.request, guard)
  await write(f.source, "hooks/check.py", "changed native checker")
  await expect(f.service.create("owner", preview.previewId, randomUUID(), guard)).rejects.toThrow(
    "来源已变化"
  )
  expect(f.service.list("owner")).toEqual([])
})

it("rejects unsafe custom resources, version and dependency conflicts", async () => {
  const f = await fixture()
  await expect(
    f.service.preview("owner", { ...f.request, order: ["specs", "prd"] }, guard)
  ).rejects.toThrow("顺序与依赖冲突")
  await expect(
    f.service.preview("owner", { ...f.request, name: "original" }, guard)
  ).rejects.toThrow("来源不同")
  const catalog = JSON.parse(await readFile(join(f.user, BUSINESS_MOD_MANIFEST), "utf8"))
  catalog.modules[0].resources = ["json.py"]
  await write(f.user, "json.py", "# Must not shadow Python stdlib")
  await write(f.user, BUSINESS_MOD_MANIFEST, catalog)
  const inspected = await f.service.inspect(f.user, "owner", guard)
  await expect(
    f.service.preview(
      "owner",
      {
        ...f.request,
        sources: [f.request.sources[0], { inspectionId: inspected.id, modIds: ["user.quality"] }]
      },
      guard
    )
  ).rejects.toThrow("命名空间")
})

it("does not install or export unverified/tampered bytes and resumes the same creation request", async () => {
  const f = await fixture(),
    requestId = randomUUID()
  const preview = await f.service.preview("owner", f.request, guard)
  const copy = await f.service.create("owner", preview.previewId, requestId, guard)
  expect(await f.service.create("owner", preview.previewId, requestId, guard)).toEqual(copy)
  await expect(f.service.install("owner", copy.copyId, copy.digest, guard)).rejects.toThrow(
    "先检查"
  )
  await expect(
    f.service.export("owner", copy.copyId, copy.digest, join(f.root, "bad.zip"), guard)
  ).rejects.toThrow("先检查")
  await write(join(f.root, "work", copy.copyId, "source"), "hooks/check.py", "tampered")
  await expect(f.service.check("owner", copy.copyId, copy.digest, guard)).rejects.toThrow("已变化")
  expect(f.install).not.toHaveBeenCalled()
})

it("reassembles a generated lightweight package with another source into a third independent plugin", async () => {
  const f = await fixture()
  const first = await f.service.preview(
    "owner",
    { ...f.request, sources: [f.request.sources[0]] },
    guard
  )
  const created = await f.service.create("owner", first.previewId, randomUUID(), guard)
  const original = join(f.root, "work", created.copyId, "source")
  const inspected = await f.service.inspect(original, "owner", guard)
  expect(inspected.mods.map((mod) => mod.id)).toEqual(["prd", "specs"])
  const third = await f.service.preview(
    "owner",
    {
      name: "third-generation",
      version: "1.0.0",
      sources: [{ inspectionId: inspected.id, modIds: ["prd", "specs"] }, f.request.sources[1]]
    },
    guard
  )
  const copy = await f.service.create("owner", third.previewId, randomUUID(), guard)
  const root = join(f.root, "work", copy.copyId, "source")
  const manifest = JSON.parse(await readFile(join(root, BUSINESS_MOD_MANIFEST), "utf8"))
  expect(manifest.modules.map((mod: { id: string }) => mod.id)).toEqual([
    "prd",
    "specs",
    "user.quality"
  ])
  const board = JSON.parse(await readFile(join(root, "board_core/board_config.json"), "utf8"))
  expect(
    board.workflow.nodes[1].states.find((state: { id: string }) => state.id === "done").nextAction
      .slashSkill
  ).toBe("my-quality")
  expect(
    board.workflow.nodes[2].states.find((state: { id: string }) => state.id === "done").nextAction
      .userMessage
  ).toContain("本组装流程已完成")
  expect(board.workflow.nodes[2].validators).toEqual(["business:user.quality"])
  expect(board.workflow.nodes[2].artifacts.outputs[0].path).toBe("QUALITY.md")
  expect((await snapshotDerivationSource(original)).digest).toBe(created.digest)
})

it("replaces the owner's old preview during ordinary editing instead of exhausting an eight-preview quota", async () => {
  const f = await fixture()
  let first = "",
    latest = ""
  for (let index = 0; index < 10; index++) {
    const preview = await f.service.preview(
      "owner",
      { ...f.request, name: `edited-${index}` },
      guard
    )
    first ||= preview.previewId
    latest = preview.previewId
  }
  await expect(f.service.create("owner", first, randomUUID(), guard)).rejects.toThrow("预览已过期")
  expect((await f.service.create("owner", latest, randomUUID(), guard)).name).toBe("edited-9")
})

it("does not let a custom source replace an unselected kernel business skill", async () => {
  const f = await fixture()
  const catalog = JSON.parse(await readFile(join(f.user, BUSINESS_MOD_MANIFEST), "utf8"))
  catalog.modules[0].node.skill = "make-code"
  catalog.modules[0].skill = { entry: "skills/make-code/SKILL.md", resources: [] }
  await write(f.user, "skills/make-code/SKILL.md", "# Shadow the unselected original skill")
  await write(f.user, BUSINESS_MOD_MANIFEST, catalog)
  const inspected = await f.service.inspect(f.user, "owner", guard)
  await expect(
    f.service.preview(
      "owner",
      {
        ...f.request,
        sources: [f.request.sources[0], { inspectionId: inspected.id, modIds: ["user.quality"] }]
      },
      guard
    )
  ).rejects.toThrow("复用")
})

it("preserves selected source skip locks without adding unselected business nodes", async () => {
  const f = await fixture()
  const boardPath = join(f.source, "board_core/board_config.json")
  const board = JSON.parse(await readFile(boardPath, "utf8"))
  board.workflow.skipPolicy = { lockedNodes: ["code"], retainedSetting: true }
  await write(f.source, "board_core/board_config.json", board)
  const source = await f.service.inspect(f.source, "owner", guard)
  for (const includeCode of [false, true]) {
    const preview = await f.service.preview(
      "owner",
      {
        name: includeCode ? "with-locked-code" : "light-docs",
        version: "1.0.0",
        order: includeCode ? ["prd", "specs", "code"] : ["prd", "specs"],
        sources: [
          {
            inspectionId: source.id,
            modIds: includeCode ? ["prd", "specs", "code"] : ["prd", "specs"]
          }
        ]
      },
      guard
    )
    const copy = await f.service.create("owner", preview.previewId, randomUUID(), guard)
    const output = JSON.parse(
      await readFile(
        join(f.root, "work", copy.copyId, "source", "board_core/board_config.json"),
        "utf8"
      )
    )
    expect(output.workflow.skipPolicy).toEqual({
      lockedNodes: includeCode ? ["code"] : [],
      retainedSetting: true
    })
    expect(output.workflow.nodes.map((node: { id: string }) => node.id)).toEqual(
      includeCode ? ["prd", "specs", "code"] : ["prd", "specs"]
    )
  }
})

async function observerSource(root: string) {
  const source = join(root, "observer")
  const extension = {
    id: "worktree.progress",
    title: "Worktree progress",
    kind: "function",
    usage: "universal",
    entry: "mods/business/worktree.progress/register.ts",
    resources: ["mods/business/worktree.progress/inspect.py"],
    dependencies: { required: [], advisory: [] }
  }
  await write(source, "plugin.json", {
    name: "observer-source",
    version: "1.0.0",
    mods: "mods/manifest.json"
  })
  await write(source, BUSINESS_MOD_MANIFEST, {
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernelRef: { id: "autobiz.python-kernel", version: "1.0.0" },
    modules: [],
    extensions: [extension]
  })
  await write(
    source,
    extension.entry,
    `export function register(on) {
    on("command.run", async($)=>({text:$.plugin.name}))
  }`
  )
  await write(
    source,
    extension.resources[0],
    "# Explicit read-only observer, outside the Python kernel\n"
  )
  await write(source, "mods/manifest.json", {
    apiVersion: "cmb.mods/v2",
    id: "observer-source",
    claw: {
      componentsVersion: 1,
      components: [
        {
          id: extension.id,
          name: extension.title,
          kind: "module",
          entry: "business/worktree.progress/register.ts",
          dependsOn: [],
          actionIds: [],
          usage: "universal"
        }
      ]
    }
  })
  return source
}

it("adds a real compiled function beside business stages and preserves it through second-generation assembly", async () => {
  const f = await fixture()
  const source = await observerSource(f.root)
  const inspected = await f.service.inspect(source, "owner", guard)
  expect(inspected.mods).toEqual([
    {
      id: "worktree.progress",
      title: "Worktree progress",
      kind: "function",
      dependsOn: [],
      advisory: []
    }
  ])
  const request = {
    name: "docs-with-observer",
    version: "1.0.0",
    order: ["prd", "specs"],
    sources: [f.request.sources[0], { inspectionId: inspected.id, modIds: ["worktree.progress"] }]
  }
  const preview = await f.service.preview("owner", request, guard)
  expect(preview.steps.map((step) => step.id)).toEqual(["prd", "specs"])
  expect(preview.extensions?.map((entry) => entry.id)).toEqual(["worktree.progress"])
  const copy = await f.service.create("owner", preview.previewId, randomUUID(), guard)
  const directory = join(f.root, "work", copy.copyId, "source")
  const board = JSON.parse(await readFile(join(directory, "board_core/board_config.json"), "utf8"))
  expect(board.workflow.nodes.map((node: { id: string }) => node.id)).toEqual(["prd", "specs"])
  const compiled = await compileFunctionPlugin(directory)
  expect(compiled.name).toBe("docs-with-observer")
  expect(compiled.components?.map((entry) => [entry.id, entry.usage])).toEqual([
    ["worktree.progress", "universal"]
  ])
  expect(compiled.code).toContain("progress")
  const guest = await FunctionGuestRuntime.create(compiled.code)
  try {
    await expect(
      guest.invoke("0", {}, async () => ({}), {
        event: "command.run",
        origin: { plugin: "engine", tier: "core" },
        capabilities: [],
        plugin: { name: compiled.name, root: directory }
      })
    ).resolves.toEqual({ value: { text: "docs-with-observer" } })
  } finally {
    guest.dispose()
  }
  const lock = JSON.parse(await readFile(join(directory, BUSINESS_MOD_ASSEMBLY), "utf8"))
  expect(lock.mods.map((entry: { id: string }) => entry.id)).toEqual(["prd", "specs"])
  expect(lock.extensions).toEqual([
    { id: "worktree.progress", sourceDigest: inspected.sourceDigest }
  ])
  const again = await f.service.inspect(directory, "owner", guard)
  const next = await f.service.preview(
    "owner",
    {
      name: "observer-next-generation",
      version: "1.0.0",
      sources: [{ inspectionId: again.id, modIds: ["prd", "specs", "worktree.progress"] }]
    },
    guard
  )
  const nextCopy = await f.service.create("owner", next.previewId, randomUUID(), guard)
  const nextDirectory = join(f.root, "work", nextCopy.copyId, "source")
  expect((await compileFunctionPlugin(nextDirectory)).name).toBe("observer-next-generation")
  expect(next.extensions).toHaveLength(1)
  await expect(
    f.service.preview("owner", { ...request, order: ["prd", "specs", "worktree.progress"] }, guard)
  ).rejects.toThrow("顺序无效")
})

it("keeps observer resources portable without copying output or unselected checkout files", async () => {
  const f = await fixture(),
    source = await observerSource(f.root)
  await write(source, "output/private-evidence.json", "not a module resource")
  await write(source, "tests/unused.ts", "not a module resource")
  await write(source, "demo/prepare.py", "# Explicit tutorial, not a runtime resource")
  await write(source, "demo/advance.py", "# Explicit user-driven demo advance, outside runtime")
  await write(source, "demo/templates/plan.json", "{}")
  await write(source, "demo/private-notes.txt", "not a published tutorial")
  const portable = portableBusinessModFiles(await snapshotDerivationSource(source))
  expect(portable.map((file) => file.path)).toEqual([
    "demo/advance.py",
    "demo/prepare.py",
    "demo/templates/plan.json",
    "mods/business/manifest.json",
    "mods/business/worktree.progress/inspect.py",
    "mods/business/worktree.progress/register.ts",
    "mods/manifest.json",
    "plugin.json"
  ])
})
