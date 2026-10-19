import { randomUUID } from "node:crypto"
import { basename, join, resolve } from "node:path"
import type { NativeNodeCatalog, NativeNodePlan } from "../../shared/node-composition"
import {
  closeBusinessModSelection,
  type BusinessModSelectionPolicy
} from "../plugins/business-mod-selection"
import type {
  HarnessFeatureCreateInput,
  HarnessFeatureCreateResult
} from "../../shared/harness-board-types"

export interface NativeNodeContext extends NativeNodeCatalog {
  strictBusinessSelection?: BusinessModSelectionPolicy
  fingerprint: string
  sourceIdentity: string
  invocation: { cwd: string; invocation: { executable: string; args: string[] } }
}

/** Only the installed AutoBiz inspection protocol can opt into native closure execution. */
export function nativeClosureInvocation(
  context: NativeNodeContext,
  template: string,
  ids: string[],
  includeOptionalDependencies = true
) {
  if (typeof includeOptionalDependencies !== "boolean") throw Error("可选输入的上游步骤选择无效。")
  const { cwd, invocation } = context.invocation
  const expected = resolve(cwd, "hooks/inspect_workflow_templates.py")
  const scriptIndex = invocation.args.findIndex((arg) => resolve(cwd, arg) === expected)
  if (
    !/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(basename(invocation.executable)) ||
    scriptIndex < 0 ||
    !["[]", '["-X","utf8"]'].includes(JSON.stringify(invocation.args.slice(0, scriptIndex))) ||
    !["[]", '["--mode","templates"]'].includes(
      JSON.stringify(invocation.args.slice(scriptIndex + 1))
    )
  )
    throw Error("这个插件尚未提供可验证的节点组合入口，请使用原项目流程。")
  return {
    cwd,
    invocation: {
      executable: invocation.executable,
      args: [
        ...invocation.args.slice(0, scriptIndex),
        join(cwd, "hooks/inspect_workflow_templates.py"),
        "--mode",
        "closure",
        "--template",
        template,
        "--nodes",
        ids.join(","),
        ...(includeOptionalDependencies && context.strictBusinessSelection?.templateId !== template
          ? ["--auto-include"] : [])
      ]
    }
  }
}

export function nativeClosureSelectedNodes(
  context: NativeNodeContext,
  templateId: string,
  selected: string[],
  includeOptionalDependencies = true
) {
  const template = context.config.templates.find(
    (item) => item.id === templateId && item.templateType === "custom"
  )
  if (!template) throw Error("请选择支持自选节点的工作流。")
  const known = new Set(context.config.nodes.map((node) => node.id))
  const validId = (id: unknown): id is string =>
    typeof id === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(id) && known.has(id)
  if (
    !Array.isArray(selected) ||
    selected.length === 0 ||
    selected.length > 128 ||
    !selected.every(validId) ||
    new Set(selected).size !== selected.length
  )
    throw Error("节点选择无效，请重新选择。")
  return context.strictBusinessSelection?.templateId === templateId
    ? closeBusinessModSelection(context.strictBusinessSelection, selected, includeOptionalDependencies)
    : selected
}

export function validateNativeClosure(
  context: NativeNodeContext,
  templateId: string,
  selected: string[],
  response: unknown,
  includeOptionalDependencies = true
) {
  const requiredSelection = nativeClosureSelectedNodes(context, templateId, selected, includeOptionalDependencies)
  const template = context.config.templates.find((item) => item.id === templateId)!
  const known = new Set(context.config.nodes.map((node) => node.id))
  const validId = (id: unknown): id is string => typeof id === "string" && known.has(id)
  const strict = context.strictBusinessSelection?.templateId === templateId
  const value = response as {
    ok?: unknown
    mode?: unknown
    closure?: { nodes?: unknown; dropped?: unknown }
  }
  const closure = value?.closure
  if (
    value?.ok !== true ||
    value.mode !== "closure" ||
    !closure ||
    !Array.isArray(closure.nodes) ||
    closure.nodes.length > 128 ||
    !closure.nodes.every(validId) ||
    new Set(closure.nodes).size !== closure.nodes.length ||
    !closure.dropped ||
    typeof closure.dropped !== "object" ||
    Array.isArray(closure.dropped)
  )
    throw Error("节点依赖检查未通过，不能省略原有输入或检查。")
  const optionalOmissions: Array<{ nodeId: string; path: string }> = []
  const entryInputFallbacks: Array<{ nodeId: string; path: string; guidance: string }> = []
  for (const [nodeId, paths] of Object.entries(closure.dropped)) {
    const node = context.nodes.find((item) => item.id === nodeId)
    if (
      !node ||
      !closure.nodes.includes(nodeId) ||
      !Array.isArray(paths) ||
      paths.length > 64 ||
      !paths.every(
        (path) =>
          typeof path === "string" &&
          node.inputs.includes(path) &&
          (node.optionalInputs.includes(path) ||
            (!strict &&
            node.entryInputs?.some(
              (entry) =>
                entry.path === path &&
                typeof entry.guidance === "string" &&
                entry.guidance.trim() &&
                entry.guidance.length <= 4000
            )))
      )
    )
      throw Error("节点依赖检查未通过，不能省略原有必需输入或检查。")
    for (const path of paths) {
      if (node.optionalInputs.includes(path)) optionalOmissions.push({ nodeId, path })
      else {
        const entry = node.entryInputs!.find((item) => item.path === path)!
        entryInputFallbacks.push({ nodeId, path, guidance: entry.guidance })
      }
    }
  }
  const result = new Set(closure.nodes as string[])
  if (![...requiredSelection, ...template.requiredNodes].every((id) => result.has(id)))
    throw Error("节点检查遗漏了已选步骤或必选步骤，请重新检查。")
  if (strict && JSON.stringify(closure.nodes) !== JSON.stringify(requiredSelection))
    throw Error("业务步骤闭包与已核验的来源不一致，请重新检查。")
  const ordered = context.config.nodes.filter((node) => result.has(node.id)).map((node) => node.id)
  if (JSON.stringify(ordered) !== JSON.stringify(closure.nodes))
    throw Error("节点顺序与原项目流程不一致。")
  return {
    ordered,
    added: ordered.filter((id) => !selected.includes(id)),
    optionalOmissions,
    entryInputFallbacks
  }
}

interface Dependencies {
  context(projectId: string, workspace: string): Promise<NativeNodeContext>
  verify(context: NativeNodeContext, workspace: string): Promise<void>
  run(invocation: NativeNodeContext["invocation"]): Promise<unknown>
  create(
    input: HarnessFeatureCreateInput,
    guard: () => void | Promise<void>
  ): Promise<HarnessFeatureCreateResult>
}

/** Explicit preview only: no timers, background discovery, checkpoint writes or alternate execution. */
export class NativeNodeComposition {
  private readonly plans = new Map<
    string,
    {
      owner: string
      fingerprint: string
      plan: NativeNodePlan
      state: "ready" | "creating" | "done" | "failed"
      result?: HarnessFeatureCreateResult
      feature?: string
    }
  >()
  private readonly busy = new Set<string>()
  constructor(private readonly deps: Dependencies) {}

  async preview(
    owner: string,
    workspace: string,
    projectId: string,
    templateId: string,
    selected: string[],
    guard: () => void,
    includeOptionalDependencies = true
  ) {
    guard()
    if (this.busy.has(owner) || this.busy.size >= 4) throw Error("正在检查节点，请稍候。")
    this.busy.add(owner)
    try {
      for (const [id, record] of this.plans)
        if (record.plan.expiresAt < Date.now() && record.state !== "creating") this.plans.delete(id)
      if (this.plans.size >= 64) throw Error("节点预览过多，请稍后重试。")
      const context = await this.deps.context(projectId, workspace)
      // Validate user inputs before any adapter execution.
      const requiredSelection = nativeClosureSelectedNodes(context, templateId, selected, includeOptionalDependencies)
      guard()
      const response = await this.deps.run(
        nativeClosureInvocation(context, templateId, requiredSelection, includeOptionalDependencies)
      )
      const { ordered, added, optionalOmissions, entryInputFallbacks } = validateNativeClosure(
        context,
        templateId,
        selected,
        response,
        includeOptionalDependencies
      )
      const latest = await this.deps.context(projectId, workspace)
      if (latest.fingerprint !== context.fingerprint)
        throw Error("项目或插件已变化，请重新检查节点。")
      guard()
      const plan: NativeNodePlan = {
        project: context.project,
        config: context.config,
        nodes: context.nodes,
        planId: randomUUID(),
        templateId,
        selected,
        includeOptionalDependencies,
        ordered,
        added,
        optionalOmissions,
        entryInputFallbacks,
        expiresAt: Date.now() + 30 * 60_000
      }
      this.plans.set(plan.planId, { owner, fingerprint: context.fingerprint, plan, state: "ready" })
      return structuredClone(plan)
    } finally {
      this.busy.delete(owner)
    }
  }

  async create(
    owner: string,
    workspace: string,
    planId: string,
    input: HarnessFeatureCreateInput,
    guard: () => void,
    acknowledgeEntryRequirements = false
  ) {
    guard()
    const record = this.plans.get(planId)
    if (!record || record.owner !== owner || record.plan.expiresAt < Date.now())
      throw Error("节点预览已过期，请重新选择并检查。")
    if (!input || input.projectId !== record.plan.project.projectId) throw Error("目标项目已变化。")
    const signature = JSON.stringify(input)
    if (record.state === "done" && record.feature === signature)
      return structuredClone(record.result!)
    if (record.state !== "ready") throw Error("这次创建已提交，请先在项目中检查结果。")
    if (record.plan.entryInputFallbacks.length && acknowledgeEntryRequirements !== true)
      throw Error("请先确认入口输入要求，进入原项目后按要求补充资料。")
    record.state = "creating"
    try {
      const context = await this.deps.context(input.projectId, workspace)
      if (context.fingerprint !== record.fingerprint)
        throw Error("项目或插件已变化，请重新检查节点。")
      guard()
      // Renderer's config/selection are not authoritative; the reviewed closure is immutable.
      const commitGuard = async () => {
        guard()
        // Called after the adapter semaphore is acquired. Never execute another adapter here.
        await this.deps.verify(context, workspace)
        guard()
      }
      const result = await this.deps.create(
        {
          ...input,
          workflowTemplate: record.plan.templateId,
          workflowNodes: record.plan.ordered,
          workflowConfig: record.plan.config
        },
        commitGuard
      )
      record.result = result
      record.feature = signature
      record.state = "done"
      return result
    } catch (error) {
      record.state = "failed"
      throw error
    }
  }
}
