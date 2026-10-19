import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { BusinessModAssemblyService } from "../src/main/plugins/business-mod-assembly-service"
import { businessModCatalog } from "../src/main/plugins/business-mod-manifest"
import { portableBusinessModFiles } from "../src/main/plugins/business-mod-portable-source"
import {
  snapshotDerivationSource,
  writeDerivationFiles
} from "../src/main/plugins/derivation-source"
import { isReviewedAutobizBusinessAssembly } from "../src/main/plugins/autobiz-business-assembly-protocol"
import { compileFunctionPlugin } from "../src/main/mods/v2/loader"
import { prepareAutobizKnowledgeMod } from "./prepare-autobiz-knowledge-mod"
import { getPluginSkillSearchSources, readPluginManifest } from "../src/main/plugins/manifest"
import { projectRuntimeExtensionContract } from "../src/shared/project-runtime"

const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex")
async function main() {
  assert(
    process.argv[2],
    "Usage: <new-staging-directory> [AutoBiz-source] [observer-source] [warehouse-source] [custom-source]"
  )
  const destination = resolve(process.argv[2])
  const auto = resolve(process.argv[3] ?? "C:/ai/autobiz_kanban")
  const currentSources = resolve(
    __dirname,
    "../output/deliveries/business-mods-warehouse-20261016-staging-v4/Mods来源"
  )
  const observer = resolve(process.argv[4] ?? join(currentSources, "Worktree进度Mod"))
  const warehouse = resolve(process.argv[5] ?? join(currentSources, "数仓Mods"))
  const custom = resolve(process.argv[6] ?? join(auto, "examples/user-business-mods"))
  const autoManifest = JSON.parse(await readFile(join(auto, "mods/business/manifest.json"), "utf8"))
  const kernelVersion = autoManifest.kernel.version as string
  assert(["1.0.0", "1.0.1"].includes(kernelVersion))
  await mkdir(destination) // Existing evidence, user packages and previous deliveries are never overwritten.
  const sourcesRoot = join(destination, "Mods来源")
  await mkdir(sourcesRoot)
  const knowledge = join(sourcesRoot, "知识与上下文Mod")
  await prepareAutobizKnowledgeMod(knowledge, kernelVersion)
  const compatibilityTransforms: Array<{ source: string; digest: string; changed: string[] }> = []
  async function matchingKernelSource(title: string, directory: string): Promise<string> {
    if (kernelVersion === "1.0.0") return directory
    const snapshot = await snapshotDerivationSource(directory)
    const declarations = snapshot.files.find((file) => file.path === "mods/business/manifest.json")!
    const manifest = JSON.parse(declarations.bytes.toString("utf8"))
    assert.deepEqual(manifest.kernelRef, { id: "autobiz.python-kernel", version: "1.0.0" })
    manifest.kernelRef.version = kernelVersion
    const identity = snapshot.files.find((file) => file.path === "plugin.json")!
    const plugin = JSON.parse(identity.bytes.toString("utf8"))
    plugin.version = kernelVersion
    const changes = new Map([
      [declarations.path, Buffer.from(JSON.stringify(manifest, null, 2) + "\n")],
      [identity.path, Buffer.from(JSON.stringify(plugin, null, 2) + "\n")]
    ])
    const target = join(destination, ".compatible-sources", title)
    await mkdir(target, { recursive: true })
    await writeDerivationFiles(
      target,
      snapshot.files.map((file) =>
        changes.has(file.path)
          ? { ...file, bytes: changes.get(file.path)!, digest: hash(changes.get(file.path)!) }
          : file
      )
    )
    const prepared = await snapshotDerivationSource(target)
    for (const file of snapshot.files)
      assert.equal(
        prepared.files.find((item) => item.path === file.path)?.digest,
        changes.has(file.path) ? hash(changes.get(file.path)!) : file.digest
      )
    compatibilityTransforms.push({
      source: directory,
      digest: snapshot.digest,
      changed: [...changes.keys()]
    })
    return target
  }
  const originals = [
    ["AutoBiz", auto],
    ["文档检查", await matchingKernelSource("文档检查", custom)],
    ["数仓Mods", await matchingKernelSource("数仓Mods", warehouse)],
    ["Worktree进度Mod", await matchingKernelSource("Worktree进度Mod", observer)],
    ["知识与上下文Mod", knowledge]
  ] as const
  const sourceReport = [] as Array<{
    title: string
    sourceDigest: string
    portableDigest: string
    files: number
    zip: string
    sha256: string
  }>
  for (const [index, [title, directory]] of originals.entries()) {
    const original = await snapshotDerivationSource(directory)
    const files = portableBusinessModFiles(original)
    const output = join(sourcesRoot, title)
    if (directory !== output) {
      await mkdir(output)
      await writeDerivationFiles(output, files)
    }
    const copied = await snapshotDerivationSource(output)
    assert(
      copied.files.length === files.length &&
        files.every((file) =>
          copied.files.some((entry) => entry.path === file.path && entry.digest === file.digest)
        ),
      "Portable source byte mismatch"
    )
    assert(
      !copied.files.some((file) => /^(?:output|tests|\.git|node_modules)\//.test(file.path)),
      "Unexpected checkout data"
    )
    if (copied.files.some((file) => file.path === "mods/manifest.json"))
      await compileFunctionPlugin(output)
    const zip = new AdmZip()
    for (const file of copied.files) zip.addFile(file.path, file.bytes)
    const zipName = `0${index + 1}-来源-${title}.zip`
    const zipBytes = zip.toBuffer()
    await writeFile(join(destination, zipName), zipBytes, { flag: "wx" })
    const published = new AdmZip(zipBytes)
    assert.equal(published.getEntries().length, copied.files.length)
    for (const file of copied.files)
      assert.equal(hash(published.getEntry(file.path)!.getData()), file.digest)
    sourceReport.push({
      title,
      sourceDigest: original.digest,
      portableDigest: copied.digest,
      files: files.length,
      zip: zipName,
      sha256: hash(zipBytes)
    })
  }
  const service = new BusinessModAssemblyService(join(destination, ".assembly-work"), {
    plugins: () => [],
    validatePackage: async (directory) => {
      const snapshot = await snapshotDerivationSource(directory)
      assert(
        isReviewedAutobizBusinessAssembly(snapshot),
        "Generated package must retain the reviewed kernel and business definitions"
      )
      if (snapshot.files.some((file) => file.path === "mods/manifest.json"))
        await compileFunctionPlugin(directory)
      const runtime = JSON.parse(
        await readFile(join(directory, "devclaw.project-runtime.json"), "utf8")
      )
      assert.deepEqual(projectRuntimeExtensionContract(runtime)?.context, {
        sourceAccess: "read-only",
        mutableData: "host",
        configuration: "host-resolved",
        knowledge: { required: true, binding: "knowledgeRoot" },
        provider: {
          entry: "mods/business/autobiz.knowledge/provider.py",
          operations: ["session-context", "sync-knowledge"]
        }
      })
      assert(
        getPluginSkillSearchSources(directory, readPluginManifest(directory)?.manifest).some(
          (source) => source.relPath === "mods/business/autobiz.knowledge/skills/knowledge-sync"
        ),
        "The original Skill discovery must include knowledge-sync"
      )
    },
    install: async () => {
      throw Error("Packaging does not install plugins")
    },
    invalidate() {
      /* No application catalog is changed by packaging. */
    }
  })
  const guard = () => {
    /* This standalone build owns its new output directory. */
  }
  const inspections = await Promise.all(
    ["AutoBiz", "数仓Mods", "Worktree进度Mod", "文档检查", "知识与上下文Mod"].map((title) =>
      service.inspect(join(sourcesRoot, title), "demo-build", guard)
    )
  )
  const autoCatalog = businessModCatalog(
    await snapshotDerivationSource(join(sourcesRoot, "AutoBiz"))
  )
  const warehouseCatalog = businessModCatalog(
    await snapshotDerivationSource(join(sourcesRoot, "数仓Mods"))
  )
  const plans = [
    {
      name: "autobiz-full-worktree-knowledge-demo",
      output: "10-完整AutoBiz+并行进度+知识版.zip",
      mods: autoCatalog.modules.map((mod) => mod.id),
      warehouse: [] as string[],
      documents: [] as string[],
      observer: true
    },
    {
      name: "autobiz-warehouse-worktree-knowledge-demo",
      output: "11-数仓开发+进度+知识版.zip",
      mods: ["biz.prd", "dev.specs"],
      warehouse: warehouseCatalog.modules.map((mod) => mod.id),
      documents: [] as string[],
      observer: true
    },
    {
      name: "my-autobiz-docs-knowledge",
      output: "12-需求规格+知识版.zip",
      mods: ["biz.prd", "dev.specs"],
      warehouse: [] as string[],
      documents: [] as string[],
      observer: false
    },
    {
      name: "my-autobiz-docs-quality-knowledge",
      output: "13-文档交付扩展+知识版.zip",
      mods: ["biz.prd", "dev.specs"],
      warehouse: [] as string[],
      documents: ["user.docs-quality"],
      observer: false
    }
  ]
  const packages: Array<{
    title: string
    name: string
    sha256: string
    files: number
    functions: string[]
    steps: string[]
    diagnostics: string[]
  }> = []
  for (const plan of plans) {
    const preview = await service.preview(
      "demo-build",
      {
        name: kernelVersion === "1.0.1" ? `${plan.name}-compat-v101` : plan.name,
        version: kernelVersion === "1.0.1" ? "1.0.1" : "1.1.0",
        order: [...plan.mods, ...plan.warehouse, ...plan.documents],
        sources: [
          { inspectionId: inspections[0].id, modIds: plan.mods },
          ...(plan.warehouse.length
            ? [{ inspectionId: inspections[1].id, modIds: plan.warehouse }]
            : []),
          ...(plan.documents.length
            ? [{ inspectionId: inspections[3].id, modIds: plan.documents }]
            : []),
          ...(plan.observer
            ? [{ inspectionId: inspections[2].id, modIds: ["autobiz.worktree-progress"] }]
            : []),
          { inspectionId: inspections[4].id, modIds: ["autobiz.knowledge"] }
        ]
      },
      guard
    )
    assert(preview.valid, preview.diagnostics.join("\n"))
    assert(
      !preview.requiresFixedWorkflowAcknowledgement,
      "Source/resource closure must be complete without fixed-workflow acknowledgement"
    )
    const copy = await service.create("demo-build", preview.previewId, randomUUID(), guard)
    await service.check("demo-build", copy.copyId, copy.digest, guard)
    const output = join(destination, plan.output)
    await service.export("demo-build", copy.copyId, copy.digest, output, guard)
    const snapshot = await snapshotDerivationSource(
      join(destination, ".assembly-work", copy.copyId, "source")
    )
    const originalBoard = JSON.parse(
      await readFile(join(sourcesRoot, "AutoBiz/board_core/board_config.json"), "utf8")
    )
    const board = JSON.parse(
      snapshot.files
        .find((file) => file.path === "board_core/board_config.json")!
        .bytes.toString("utf8")
    )
    assert.deepEqual(board.inspectCommands, originalBoard.inspectCommands)
    assert.deepEqual(board.knowledge_config, originalBoard.knowledge_config)
    if (plan.mods.length === autoCatalog.modules.length)
      assert.deepEqual(
        board.workflow.dynamicStages,
        originalBoard.workflow.dynamicStages,
        "The complete AutoBiz preset must retain its original dynamic branches"
      )
    const hooks = await readFile(join(sourcesRoot, "AutoBiz/hooks/hooks.json"))
    assert.equal(
      hash(snapshot.files.find((file) => file.path === "hooks/hooks.json")!.bytes),
      hash(hooks)
    )
    assert(preview.extensions?.some((extension) => extension.id === "autobiz.knowledge"))
    if (plan.observer)
      assert(preview.extensions?.some((extension) => extension.id === "autobiz.worktree-progress"))
    const published = new AdmZip(await readFile(output))
    const entries = published.getEntries()
    assert.equal(
      entries.length,
      snapshot.files.length,
      "Published ZIP has an unexpected entry count"
    )
    assert.equal(
      new Set(entries.map((entry) => entry.entryName)).size,
      entries.length,
      "Published ZIP has duplicate paths"
    )
    for (const entry of entries) {
      const expected = snapshot.files.find((file) => file.path === entry.entryName)
      assert(
        expected && !entry.isDirectory && hash(entry.getData()) === expected.digest,
        `Published ZIP differs from its checked package: ${entry.entryName}`
      )
    }
    packages.push({
      title: plan.output,
      name: copy.name,
      sha256: hash(await readFile(output)),
      files: copy.fileCount,
      functions: preview.extensions?.map((item) => item.id) ?? [],
      steps: preview.steps.map((step) => step.id),
      diagnostics: preview.diagnostics
    })
  }
  for (const source of sourceReport) {
    const directory = originals.find(([title]) => title === source.title)![1]
    assert.equal(
      (await snapshotDerivationSource(directory)).digest,
      source.sourceDigest,
      "Original source changed while packaging"
    )
  }
  for (const transform of compatibilityTransforms)
    assert.equal((await snapshotDerivationSource(transform.source)).digest, transform.digest)
  const manifest = {
    apiVersion: "devclaw.business-demo-build/v2",
    sources: sourceReport,
    kernelVersion,
    compatibilityTransforms,
    packages,
    installed: false,
    businessExecuted: false,
    checks: {
      reviewedKernel: true,
      originalHooksPreserved: true,
      originalInspectCommandsPreserved: true,
      originalKnowledgeRulesPreserved: true,
      fullAutoBizDynamicBranchesPreserved: true,
      knowledgeProviderIncludedInEveryPreset: true,
      nativeKnowledgeSkillDiscovered: true,
      realFunctionCompilation: true,
      packageZipByteIdentity: true,
      fixedWorkflowAcknowledgementUsed: false,
      originalSourcesUnchanged: true,
      noOverwrite: true
    },
    scope:
      "Static source/ZIP identity, reviewed kernel admission and real function compilation; business runs have separate evidence."
  }
  for (const filename of ["构建核对.json", "manifest.json"])
    await writeFile(join(destination, filename), JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx"
    })
  await writeFile(
    join(destination, "安装与演示说明.txt"),
    `Mods 创造者最终演示插件库

本库内核版本：${kernelVersion}。${
      kernelVersion === "1.0.1"
        ? "本轮为独立的Plan合并凭据投影兼容版本，成品标识含compat-v101，不覆盖旧插件。只有原任务、四阶段证据、同批次运行/合并凭据和真实Git HEAD一致时才完成计划；保留全部原Hooks及code_done检查。"
        : "保持原始内核。"
    }

一、目录与安装
01至05为可组合的来源ZIP：原AutoBiz、用户文档检查、数仓Mods、Worktree进度Mod、知识与上下文Mod。
10至13为可直接安装的新插件；每个均包含autobiz.knowledge提供器和knowledge-sync技能。
直接演示请选择10-完整AutoBiz+并行进度+知识版.zip或11-数仓开发+进度+知识版.zip，
通过应用原“安装插件”入口安装，然后在项目模式选择对应的新插件。
来源ZIP用于创造者重新组合，不需要为使用一个成品而安装全部来源。
相同名称插件的变更通过原安装入口确认更新，保留原安装身份和配置；权限变化仍需确认。
本目录的生成过程没有安装或启用任何插件，没有修改外部AutoBiz或用户应用。

二、一句话创造与组合
需要现场创造时，先安装所需来源ZIP，然后进入普通本地会话的创造者模式。
示例：基于已安装的AutoBiz保留原Hooks、知识和产物检查，加入知识模块及Worktree进度模块，
生成一个新的完整开发插件；先展示组合检查，经过我确认后安装或导出。
数仓示例：保留需求与规格步骤，组合数仓建模、SQL实现和校验步骤，加入知识与Worktree进度模块，
生成一个新的数仓开发插件。先检查上游产物依赖，不能删除原校验来通过。
自定义示例：读取自有文档检查Mod的实现，将它放在规格之后，组合生成新的文档交付插件。
助手可以读取来源、制作自己的Mod、检查依赖和生成候选；安装、导出和运行权限由原生界面确认。
检查、编译、安装和业务执行是不同状态，不能把生成或安装成功当作业务流程已经运行。

三、知识与本机配置
安装后在原插件参数界面配置“只读知识目录”（knowledgeRoot）。
选择已有知识目录时，该目录只作只读来源；不会授权同步写入、清空或删除外部目录。
绑定外部只读目录后，“同步项目约束”会明确拒绝写入该目录。
留空则使用平台分配的插件共享缓存；可通过原“同步项目约束”入口，按原agentsRepo规则同步。
同步需要实际可达的知识仓库、Git/SSH/网络条件；本插件库不包含企业知识内容、凭据或用户路径。
不同知识来源使用独立缓存；同一来源可以在多个聊天或工作树复用。
在实际项目或功能工作树中选择正确部署单元，确认知识装载状态后再执行任务；
必需知识未实际装载时，模型请求会被阻止，不得用虚构知识或删除必需保护绕过。
换电脑需重新绑定本机目录、参数与权限；导出包不携带保存的用户配置或密钥。

四、业务、进度与知识草稿
完整AutoBiz保留原Hooks、inspectCommands、知识规则及动态分支；
按所选步骤生成的数仓或文档流程保留其上游产物和检查合同，未选择的分支不进入该流程。
Worktree进度Mod用于观察实际workflow/worktree执行进度，不伪造任务或自动认可结果；
只有实际进入多worktree执行阶段时，才有对应的真实进度可展示。
knowledge-sync根据当前Feature的真实产物生成KNOWLEDGE_DRAFT.md和KNOWLEDGE_DRAFT.json，
校验实际来源与摘要后仍为“待人工审阅”；不会自动发布到远端知识库或将草稿当作已批准知识。
原业务阶段的人工审批、产物校验和必要Hooks继续执行，用户新增步骤不能绕过它们。

五、当前边界与核对
S6阶段回退、检查点恢复及从中间步骤对话调试尚未实现，不作为当前能力演示。
manifest.json和构建核对.json列出来源摘要、ZIP摘要、步骤、扩展与静态核对结果。
本次交付通过原assembler、check、function compiler及ZIP逐文件摘要核对；未在打包脚本中执行真实业务。
请使用当前支持devclaw.project-runtime/v2、board API 2及声明协议的客户端；旧客户端应拒绝不支持的包。
生成脚本只写全新交付目录；已有目录、ZIP和用户修改均不会被覆盖。
`,
    { flag: "wx" }
  )
  console.log(
    JSON.stringify({
      destination,
      packages,
      sources: sourceReport,
      installed: false,
      businessExecuted: false
    })
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
