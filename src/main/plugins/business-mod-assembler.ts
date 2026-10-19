import { createHash } from "node:crypto"
import type {
  BusinessModAssemblyLock,
  BusinessModAssemblyRequest,
  BusinessModCatalog,
  BusinessModDefinition,
  BusinessModExtensionDefinition
} from "../../shared/business-mods"
import { BUSINESS_MOD_ASSEMBLY, BUSINESS_MOD_MANIFEST } from "../../shared/business-mods"
import { businessModId, businessModObject, businessModResources } from "./business-mod-manifest"
import { derivationDigest, type DerivationFile, type DerivationSnapshot } from "./derivation-source"
import { parseClawComponentExports } from "../../shared/mods/claw-components"
import { parseClawActionExports } from "../../shared/mods/claw-actions"
import { businessModIntegrityDiagnostics } from "./business-mod-integrity"
import { assertPortableBusinessBoard, mergeBusinessModUserConfig } from "./business-mod-user-config"
import { projectBusinessModWorkflow } from "./business-mod-workflow-projection"
import { parseSkillNameFromFrontmatterYaml } from "../skills/frontmatter"
import { assertProjectNodeAgentResources } from "./project-agent-resources"
import { BusinessModDuplicateIdError } from "./business-mod-diagnostics"
import {
  isReviewedAutobizKernelIdentity,
  reviewedAutobizRequiredHookIds
} from "./autobiz-required-hooks"
import {
  wrapProjectRuntimeManifest,
  EXTENSION_CONTRACT_API_VERSION,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  CONTEXT_HANDOFF_PROTOCOL,
  VERIFIED_ARTIFACTS_PROTOCOL,
  EXTENSION_BOARD_API_VERSION,
  type ExtensionContract
} from "../../shared/project-runtime"
import { AUTOBIZ_CONTEXT_OUTPUT } from "../../shared/project-runtime/autobiz-handoff"
import {
  businessModCheckpoints as checkpoints,
  projectBusinessModNodes
} from "./business-mod-workflow"

export interface BusinessModAssemblySource {
  snapshot: DerivationSnapshot
  catalog: BusinessModCatalog
  modIds: string[]
}
type BusinessSelection = {
  kind: "business"
  source: BusinessModAssemblySource
  mod: BusinessModDefinition
}
type FunctionSelection = {
  kind: "function"
  source: BusinessModAssemblySource
  mod: BusinessModExtensionDefinition
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n")
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
function generated(path: string, value: unknown): DerivationFile {
  const bytes = json(value)
  return { path, bytes, mode: process.platform === "win32" ? 0o666 : 0o644, digest: digest(bytes) }
}

/** Materialize selected implementations. Never run author code or copy an entire source package. */
export function assembleBusinessMods(
  sources: BusinessModAssemblySource[],
  request: BusinessModAssemblyRequest
) {
  if (
    !/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,79}$/u.test(request.name) ||
    /[. ]$/.test(request.name) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(request.name)
  )
    throw Error("请输入独立的新插件名称")
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(request.version)) throw Error("插件版本必须精确")
  if (sources.some((source) => source.snapshot.name.toLowerCase() === request.name.toLowerCase()))
    throw Error("新插件名称必须与来源不同")
  const kernels = sources.filter((source) => source.catalog.kernel)
  if (kernels.length !== 1) throw Error("请选择且只选择一个共享内核来源")
  const main = kernels[0],
    kernel = main.catalog.kernel!
  for (const source of sources) {
    const identity = source.catalog.kernel ?? source.catalog.kernelRef!
    if (identity.id !== kernel.id || identity.version !== kernel.version)
      throw Error("业务 Mods 共享内核版本冲突")
  }
  const known = new Map<string, BusinessSelection | FunctionSelection>()
  for (const source of sources) {
    const items: Array<BusinessSelection | FunctionSelection> = [
      ...source.catalog.modules.map(
        (mod): BusinessSelection => ({ kind: "business", source, mod })
      ),
      ...(source.catalog.extensions ?? []).map(
        (mod): FunctionSelection => ({ kind: "function", source, mod })
      )
    ]
    for (const item of items) {
      const { mod } = item
      if ([...known.keys()].some((id) => id.toLowerCase() === mod.id.toLowerCase()))
        throw new BusinessModDuplicateIdError(mod.id)
      known.set(mod.id, item)
    }
  }
  const chosen = new Set<string>(),
    explicit = new Set<string>(),
    visiting = new Set<string>()
  const include = (id: string) => {
    businessModId(id)
    if (visiting.has(id)) throw Error("业务 Mods 依赖存在循环")
    if (chosen.has(id)) return
    const item = known.get(id)
    if (!item) throw Error(`业务 Mod 依赖来源缺失：${id}`)
    visiting.add(id)
    item.mod.dependencies.required.forEach(include)
    visiting.delete(id)
    chosen.add(id)
  }
  for (const source of sources) {
    if (
      !Array.isArray(source.modIds) ||
      source.modIds.length > 64 ||
      new Set(source.modIds).size !== source.modIds.length
    )
      throw Error("业务 Mod 选择无效")
    for (const id of source.modIds) {
      if (known.get(id)?.source !== source) throw Error("业务 Mod 不属于所选来源")
      explicit.add(id)
      include(id)
    }
  }
  if (!chosen.size || chosen.size > 64) throw Error("业务步骤与常驻扩展选择超限")
  const order = request.order ?? []
  if (
    !Array.isArray(order) ||
    new Set(order).size !== order.length ||
    order.some((id) => !chosen.has(id) || known.get(id)?.kind !== "business")
  )
    throw Error("业务 Mods 顺序无效")
  for (const id of order) {
    const item = known.get(id)!
    if (item.kind !== "business") throw Error("常驻扩展不能放入业务步骤顺序")
    const mod = item.mod
    const preceding = [
      ...mod.dependencies.required,
      ...(mod.insertAfter && chosen.has(mod.insertAfter) ? [mod.insertAfter] : [])
    ]
    if (
      preceding.some(
        (dependency) => order.includes(dependency) && order.indexOf(dependency) > order.indexOf(id)
      )
    )
      throw Error(`业务 Mods 顺序与依赖冲突：${id}`)
  }
  const priority = (id: string) =>
    order.includes(id)
      ? order.indexOf(id)
      : order.length +
        (known.get(id)!.kind === "business"
          ? Number((known.get(id)! as BusinessSelection).mod.node.order ?? 1000)
          : 100_000)
  const ordered: string[] = []
  const remaining = new Set(chosen)
  while (remaining.size) {
    const available = [...remaining]
      .filter((id) => {
        const item = known.get(id)!,
          mod = item.mod
        return (
          mod.dependencies.required.every((dep) => ordered.includes(dep)) &&
          (item.kind !== "business" ||
            !item.mod.insertAfter ||
            !chosen.has(item.mod.insertAfter) ||
            ordered.includes(item.mod.insertAfter))
        )
      })
      .sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))
    if (!available.length) throw Error("业务 Mods 插入位置与依赖冲突")
    ordered.push(available[0])
    remaining.delete(available[0])
  }
  const diagnostics: string[] = []
  const files = new Map<string, DerivationFile>()
  const add = (file: DerivationFile) => {
    const existing = [...files.values()].find(
      (item) => item.path.toLowerCase() === file.path.toLowerCase()
    )
    if (existing && (existing.path !== file.path || existing.digest !== file.digest))
      throw Error(`业务 Mod 资源冲突，不能覆盖：${file.path}`)
    if (!existing) files.set(file.path, { ...file, bytes: Buffer.from(file.bytes) })
  }
  const kernelFiles = businessModResources(main.snapshot, kernel.resources).filter(
    (file) => file.path !== kernel.boardConfigPath
  )
  for (const file of kernelFiles) {
    if (main.catalog.modules.some((mod) => mod.skill.entry === file.path))
      throw Error("共享内核不能包含未选择的业务 Skill")
    add(file)
  }
  const selected = ordered
    .map((id) => known.get(id)!)
    .filter((item): item is BusinessSelection => item.kind === "business")
  const extensions = ordered
    .map((id) => known.get(id)!)
    .filter((item): item is FunctionSelection => item.kind === "function")
  const userConfig = mergeBusinessModUserConfig([
    kernel.pluginFields?.userConfig,
    ...selected.map(({ mod }) => mod.userConfig),
    ...extensions.map(({ mod }) => mod.userConfig)
  ])
  const providers = extensions.filter(({ mod }) => mod.contextProvider)
  if (providers.length > 1) throw Error("所选业务 Mods 包含多个上下文提供器，请保留一个")
  const contextProvider = providers[0]?.mod.contextProvider
  const verifiedArtifactIds = request.verifiedArtifactIds
  if (verifiedArtifactIds !== undefined) {
    if (!isReviewedAutobizKernelIdentity(kernel))
      throw Error("VERIFIED_ARTIFACTS_ADAPTER_UNSUPPORTED")
    if (!Array.isArray(verifiedArtifactIds) || !verifiedArtifactIds.length ||
      verifiedArtifactIds.length > 64 || new Set(verifiedArtifactIds).size !== verifiedArtifactIds.length ||
      !verifiedArtifactIds.every(id => typeof id === "string" && /^[a-zA-Z0-9][\w.-]{0,79}$/.test(id)))
      throw Error("VERIFIED_ARTIFACTS_SELECTION_INVALID")
    const outputs = selected.flatMap(({ mod }) => {
      const artifacts = businessModObject(mod.node.artifacts ?? {})
      return Array.isArray(artifacts.outputs) ? artifacts.outputs.map(output => businessModObject(output)) : []
    })
    for (const id of verifiedArtifactIds)
      if (outputs.filter(output => output.id === id).length !== 1)
        throw Error("VERIFIED_ARTIFACTS_OUTPUT_UNDECLARED_OR_AMBIGUOUS")
  }
  const extensionContract: ExtensionContract = {
    apiVersion: EXTENSION_CONTRACT_API_VERSION,
    requires: [
      REQUIRED_BUSINESS_CHECKS_PROTOCOL,
      ...(contextProvider ? [CONTEXT_HANDOFF_PROTOCOL] : []),
      ...(verifiedArtifactIds ? [VERIFIED_ARTIFACTS_PROTOCOL] : [])
    ],
    ...(verifiedArtifactIds ? { verifiedArtifacts: { artifactIds: [...verifiedArtifactIds] } } : {}),
    ...(contextProvider
      ? {
          context: {
            sourceAccess: "read-only",
            mutableData: "host",
            configuration: "host-resolved",
            knowledge: {
              required: contextProvider.required,
              ...(contextProvider.knowledgeBinding
                ? { binding: contextProvider.knowledgeBinding }
                : {})
            },
            provider: { entry: contextProvider.entry, operations: contextProvider.operations }
          }
        }
      : {})
  }
  if (!selected.length || selected.length > 32 || extensions.length > 32)
    throw Error("请保留1至32个业务步骤，常驻扩展最多32个")
  if (extensions.length && !/^[a-zA-Z0-9][\w.-]{0,99}$/.test(request.name))
    throw Error("含常驻扩展的插件名称仅支持英文、数字、点、下划线和短横线")
  for (const { source, mod } of extensions) {
    for (const file of businessModResources(source.snapshot, [
      mod.entry,
      ...mod.resources,
      ...(mod.skills ?? [])
    ])) {
      if (!file.path.startsWith(`mods/business/${mod.id}/`))
        throw Error(`常驻扩展资源必须位于自己的命名空间：${file.path}`)
      add(file)
    }
    if (mod.contextProvider && !files.has(mod.contextProvider.entry))
      throw Error(`上下文提供器实现未包含在 Mod 资源闭包中：${mod.id}`)
    for (const id of mod.dependencies.advisory)
      if (!chosen.has(id)) diagnostics.push(`${mod.title}：未选择建议搭配 ${id}`)
  }
  const nodes = projectBusinessModNodes(selected.map(({ mod }) => mod))
  const seenSkills = new Set<string>(),
    seenCheckpoints = new Set<string>()
  for (const [index, { source, mod }] of selected.entries()) {
    const skillName = String(mod.node.skill)
    if (
      !source.catalog.kernel &&
      main.catalog.modules.some(
        (entry) => String(entry.node.skill).toLowerCase() === skillName.toLowerCase()
      )
    )
      throw Error("自有业务 Mod 不能复用共享内核来源的业务技能名称")
    if (seenSkills.has(skillName.toLowerCase())) throw Error("业务 Mods 技能名称冲突")
    seenSkills.add(skillName.toLowerCase())
    const skillRoot = mod.skill.entry.slice(0, -"/SKILL.md".length)
    const agentResources = assertProjectNodeAgentResources(mod.node,
      path => source.snapshot.files.find(file => file.path === path)?.bytes)
    const resources = businessModResources(source.snapshot, [
      mod.skill.entry,
      ...mod.skill.resources,
      ...mod.resources,
      ...agentResources
    ])
    for (const file of resources) {
      const shared = kernelFiles.some(
        (item) => item.path === file.path && item.digest === file.digest
      )
      const kernelAuxiliary =
        !!source.catalog.kernel &&
        ["skills/", "agents/", "workflows/", "references/"].some((prefix) =>
          file.path.startsWith(prefix)
        )
      if (
        !shared &&
        !kernelAuxiliary &&
        !file.path.startsWith(skillRoot + "/") &&
        !file.path.startsWith(`mods/business/${mod.id}/`)
      )
        throw Error(`业务 Mod 资源必须位于自己的命名空间：${file.path}`)
      add(file)
    }
    checkpoints(nodes[index])
    for (const checkpoint of nodes[index].checkpoints as string[]) {
      if (seenCheckpoints.has(checkpoint)) throw Error("业务 Mods 状态标识冲突")
      seenCheckpoints.add(checkpoint)
    }
    for (const id of mod.dependencies.advisory)
      if (!chosen.has(id))
        diagnostics.push(`${mod.title}：未选择建议搭配 ${id}，请核对输入与原检查要求`)
  }
  const boardFile = main.snapshot.files.find((file) => file.path === kernel.boardConfigPath)
  if (!boardFile) throw Error("共享内核流程配置缺失")
  const board = businessModObject(JSON.parse(boardFile.bytes.toString("utf8")))
  assertPortableBusinessBoard(board)
  const workflow = businessModObject(board.workflow)
  const projection = projectBusinessModWorkflow(
    selected.map(({ mod }) => mod),
    workflow
  )
  const auxiliarySkillRoots: string[] = []
  for (const { mod } of extensions) {
    for (const entry of mod.skills ?? []) {
      const file = files.get(entry)
      if (!file) throw Error(`辅助技能实现缺失：${entry}`)
      const root = entry.slice(0, -"/SKILL.md".length)
      const name =
        parseSkillNameFromFrontmatterYaml(file.bytes.toString("utf8")) ?? root.split("/").at(-1)!
      businessModId(name)
      if (seenSkills.has(name.toLowerCase()))
        throw Error(`辅助技能名称与已选步骤或扩展冲突：${name}`)
      seenSkills.add(name.toLowerCase())
      auxiliarySkillRoots.push(root)
    }
  }
  const skillSearchRoots = ["skills", ...auxiliarySkillRoots]
  const integrity = businessModIntegrityDiagnostics(board, [...files.values()], skillSearchRoots)
  diagnostics.push(...integrity.diagnostics, ...projection.diagnostics)
  const skipPolicy = workflow.skipPolicy === undefined ? {} : businessModObject(workflow.skipPolicy)
  const locked = skipPolicy.lockedNodes ?? []
  if (!Array.isArray(locked) || locked.length > 64) throw Error("共享内核跳过规则无效")
  const lockedNodes = locked.map(businessModId).filter((id) => chosen.has(id))
  const artifacts = new Set<string>()
  for (const node of nodes) {
    const contract = businessModObject(node.artifacts ?? {})
    for (const input of Array.isArray(contract.inputs) ? contract.inputs : []) {
      const artifact = businessModObject(input)
      if (artifact.required !== false && !artifacts.has(String(artifact.path))) {
        const extract =
          artifact.extract === undefined ? undefined : businessModObject(artifact.extract)
        if (!extract || typeof extract.degrade !== "string" || !extract.degrade.trim())
          throw Error(`${node.id} 必需输入没有上游生产者：${artifact.path}`)
        diagnostics.push(
          `${node.id} 输入 ${artifact.path} 来自用户或已有资料，保留原缺失处理与检查`
        )
      }
    }
    for (const output of Array.isArray(contract.outputs) ? contract.outputs : [])
      artifacts.add(String(businessModObject(output).path))
  }
  const routing = projection.routing
  const composedBoard = {
    ...board,
    apiVersion: EXTENSION_BOARD_API_VERSION,
    workflow: {
      ...workflow,
      nodes: projection.nodes,
      templates: routing.templates,
      profiles: routing.profiles,
      dynamicStages: routing.dynamicStages,
      skipPolicy: { ...skipPolicy, lockedNodes },
      checkpoints: routing.checkpoints,
      transitions: routing.transitions
    }
  }
  let requiredHooks: string[] | undefined
  if (isReviewedAutobizKernelIdentity(kernel)) {
    const hooksPath =
      typeof kernel.pluginFields?.hooks === "string"
        ? kernel.pluginFields.hooks
        : "hooks/hooks.json"
    const hookFile = files.get(hooksPath)
    if (!hookFile) throw Error("AUTOBIZ_REQUIRED_HOOKS_SOURCE_MISSING")
    requiredHooks = reviewedAutobizRequiredHookIds(JSON.parse(hookFile.bytes.toString("utf8")))
  }
  // Output identity, runtime and catalog are generated together; no source install UUID is retained.
  files.delete(kernel.boardConfigPath)
  add(generated(kernel.boardConfigPath, composedBoard))
  add(
    generated("plugin.json", {
      ...kernel.pluginFields,
      name: request.name,
      version: request.version,
      description: `由业务 Mods 组装：${selected.map(({ mod }) => mod.title).join("、")}`,
      skills: auxiliarySkillRoots.length ? skillSearchRoots : "skills",
      ...(userConfig ? { userConfig } : {}),
      ...(extensions.length ? { mods: "mods/manifest.json" } : {})
    })
  )
  add(
    generated(
      "devclaw.project-runtime.json",
      wrapProjectRuntimeManifest(
        {
          apiVersion: "devclaw.project-runtime/v1",
          plugin: { id: request.name, version: request.version },
          mode: "legacy",
          stateOwner: "plugin",
          stages: selected.map(({ mod }) => ({
            id: mod.id,
            title: mod.title,
            actionIds: [],
            artifactIds: [],
            checkIds: [],
            approval: "none"
          })),
          actions: [],
          artifacts: verifiedArtifactIds ? [{ ...AUTOBIZ_CONTEXT_OUTPUT, required: true }] : [],
          checks: [],
          environment: [],
          capabilities: {
            execution: true,
            conditionalTransition: false,
            idempotency: false,
            reconciliation: false,
            cancellation: true
          }
        },
        extensionContract
      )
    )
  )
  add(
    generated("devclaw.capabilities.json", {
      apiVersion: "devclaw.capabilities/v1",
      capabilities: [
        {
          id: "project-flow",
          title: `${request.name}项目流程`,
          kind: "flow",
          usage: "project",
          entry: "devclaw.project-runtime.json",
          ...(requiredHooks ? { requiredHooks } : {}),
          dependsOn: []
        }
      ]
    })
  )
  add(
    generated("devclaw.stage-checks.json", {
      apiVersion: "devclaw.stage-check-adapter/v1",
      adapter: "autobiz-v1"
    })
  )
  if (extensions.length) {
    const actions = extensions.flatMap(({ mod }) => mod.actions ?? [])
    const claw = {
      componentsVersion: 1,
      actions,
      components: extensions.map(({ mod }) => ({
        id: mod.id,
        name: mod.title,
        kind: "module",
        entry: mod.entry.slice("mods/".length),
        dependsOn: mod.dependencies.required.filter((id) => known.get(id)?.kind === "function"),
        actionIds: (mod.actions ?? []).map((action) => action.id),
        ...(mod.configSchema ? { configSchema: mod.configSchema } : {}),
        usage: mod.usage ?? "project"
      }))
    }
    parseClawComponentExports(claw)
    parseClawActionExports(claw)
    add(generated("mods/manifest.json", { apiVersion: "cmb.mods/v2", id: request.name, claw }))
  }
  add(
    generated("devclaw.portability.json", {
      apiVersion: "devclaw.portability/v1",
      runtimeApiVersion: "devclaw.project-runtime/v2",
      boardApiVersion: EXTENSION_BOARD_API_VERSION,
      requiredProtocols: extensionContract.requires,
      configurationKeys: Object.keys(userConfig ?? {}).sort(),
      userValuesIncluded: false,
      grantsIncluded: false,
      runtimeStateIncluded: false,
      installation:
        "Use the normal ZIP installation entry in a host that supports the declared runtime and required protocols. Bind local knowledge paths and credentials again, then authorize the installed version.",
      compatibility:
        "Requires the v2 runtime and board API 2. Hosts supporting only board API 1 reject this package through their existing version check. This report grants no authority; never remove or downgrade either manifest to bypass admission."
    })
  )
  add(
    generated(BUSINESS_MOD_MANIFEST, {
      apiVersion: "devclaw.business-mods/v1",
      kind: "catalog",
      kernel: { ...kernel, resources: kernelFiles.map((file) => file.path) },
      modules: selected.map(({ mod }) => mod),
      ...(extensions.length ? { extensions: extensions.map(({ mod }) => mod) } : {})
    })
  )
  const lock: BusinessModAssemblyLock = {
    apiVersion: "devclaw.business-assembly/v1",
    name: request.name,
    version: request.version,
    kernel: {
      id: kernel.id,
      version: kernel.version,
      files: kernelFiles.map(({ path, digest }) => ({ path, digest }))
    },
    sources: sources.map((source) => ({
      name: source.snapshot.name,
      digest: source.snapshot.digest,
      mods: [...selected, ...extensions]
        .filter((item) => item.source === source)
        .map(({ mod }) => mod.id)
    })),
    mods: selected.map(({ source, mod }) => ({
      id: mod.id,
      nodeId: String(mod.node.id),
      sourceDigest: source.snapshot.digest
    })),
    ...(extensions.length
      ? {
          extensions: extensions.map(({ source, mod }) => ({
            id: mod.id,
            sourceDigest: source.snapshot.digest
          }))
        }
      : {}),
    files: [...files.values()].map(({ path, digest }) => ({ path, digest }))
  }
  add(generated(BUSINESS_MOD_ASSEMBLY, lock))
  const result = [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"))
  return {
    files: result,
    digest: derivationDigest(result, []),
    diagnostics,
    requiresFixedWorkflowAcknowledgement: projection.requiresFixedWorkflowAcknowledgement,
    missingProviders: integrity.missingProviders,
    steps: selected.map(({ source, mod }) => ({
      id: mod.id,
      title: mod.title,
      sourceName: source.snapshot.name,
      ...(!explicit.has(mod.id) ? { added: true } : {})
    })),
    ...(extensions.length
      ? {
          extensions: extensions.map(({ source, mod }) => ({
            id: mod.id,
            title: mod.title,
            sourceName: source.snapshot.name,
            ...(!explicit.has(mod.id) ? { added: true } : {})
          }))
        }
      : {})
  }
}
