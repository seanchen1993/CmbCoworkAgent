import { cloneElement, memo, useEffect, useMemo, useState, type ReactElement } from "react"
import {
  Puzzle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Bot,
  CheckCheck,
  UserRoundCheck,
  Flag,
  Plus,
  Trash2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { flowDraftId } from "@/lib/flow-draft-id"
import {
  actionForStep,
  toolForStep,
  objectOutputPaths,
  parameterError,
  type ParameterDraft
} from "@/lib/flow-parameter-form"
import { FlowParameterEditor } from "./FlowParameterEditor"
import type {
  FlowCatalog,
  FlowDefinition,
  FlowStep,
  FlowMcpToolDescriptor
} from "../../../../shared/mods/flows/types"
import { isFlowOutputStep } from "../../../../shared/mods/flows/schema"

const field =
  "w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-sm text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50"
const icons = {
  skill: Bot,
  "mcp-tool": Puzzle,
  "plugin-action": Puzzle,
  agent: Bot,
  check: CheckCheck,
  approval: UserRoundCheck,
  "autobiz-stage": Flag
}
const kinds = {
  skill: "技能任务",
  "mcp-tool": "外部工具（MCP）",
  "plugin-action": "插件动作",
  agent: "助手任务",
  check: "运行检查",
  approval: "人工确认",
  "autobiz-stage": "Autobiz 阶段推进"
}
const checks = {
  "code-review": "代码评审",
  "unit-test": "单元测试",
  e2e: "E2E",
  "autobiz-validator": "Autobiz 业务验收"
}

function Field({
  title,
  children
}: {
  title: string
  children: ReactElement<{ "aria-label"?: string }>
}) {
  return (
    <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
      {title}
      {cloneElement(children, { "aria-label": title })}
    </label>
  )
}

function stepOfKind(step: FlowStep, kind: FlowStep["kind"]): FlowStep {
  const base = {
    id: step.id,
    name: step.name,
    enabled: step.enabled,
    when: step.when,
    onSuccess: step.onSuccess,
    onFailure: step.onFailure
  }
  if (kind === "plugin-action")
    return { ...base, kind, pluginId: "", plugin: "", digest: "", actionId: "", input: {} }
  if (kind === "skill")
    return {
      ...base,
      kind,
      skill: { id: "", name: "", digest: "" },
      prompt: "使用此 Skill 完成本步骤的任务"
    }
  if (kind === "mcp-tool")
    return {
      ...base,
      onFailure: undefined,
      kind,
      provider: { id: "", name: "", digest: "" },
      toolName: "",
      schemaDigest: "",
      input: {}
    }
  if (kind === "agent")
    return { ...base, kind, prompt: "prompt" in step ? step.prompt : "完成本步骤的任务" }
  if (kind === "approval")
    return { ...base, onFailure: undefined, kind, prompt: "请检查前序成果并决定是否继续" }
  if (kind === "check") return { ...base, kind, check: "unit-test" }
  return { ...base, when: undefined, onSuccess: undefined, onFailure: undefined, kind }
}

export const FlowEditor = memo(function FlowEditor({
  value,
  catalog,
  disabled,
  onChange,
  onEditorStateChange,
  mcpTools,
  mcpLoading = false,
  mcpError,
  onLoadMcpTools
}: {
  value: FlowDefinition
  catalog: FlowCatalog
  disabled: boolean
  onChange(value: FlowDefinition): void
  onEditorStateChange?(state: { dirty: boolean; valid: boolean }): void
  mcpTools?: FlowMcpToolDescriptor[]
  mcpLoading?: boolean
  mcpError?: string
  onLoadMcpTools?(): void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [parameterDrafts, setParameterDrafts] = useState<Record<string, ParameterDraft>>({})
  const promptOnly = value.schemaVersion === 2 && value.execution.profile === "prompt-only-v1"
  const filesOnly = value.schemaVersion === 2 && value.execution.profile === "workspace-files-v1"
  const profileErrors = (promptOnly || filesOnly)
    ? value.steps.flatMap((step) => {
        if (!["agent", "check", "approval"].includes(step.kind))
          return [`${step.name}：文本模式不支持此步骤类型（禁用的步骤也需手动移除或更换）。`]
        if (step.when || step.onSuccess || step.onFailure)
          return [`${step.name}：文本模式只支持顺序执行，请手动清除条件与跳转。`]
        return []
      })
    : []
  const outputPaths = useMemo(
    () =>
      new Map(
        value.steps
          .filter(isFlowOutputStep)
          .map((step) => [
            step.id,
            step.kind === "mcp-tool"
              ? [{ path: "/structuredContent", label: "MCP 结构化内容（需返回对象）" }]
              : objectOutputPaths(actionForStep(step, catalog.actions)?.outputSchema)
          ])
      ),
    [value.steps, catalog.actions]
  )
  const stepErrors = value.steps.flatMap((step) => {
    if (!isFlowOutputStep(step)) return []
    const action = actionForStep(step, catalog.actions)
    const inputSchema = action?.inputSchema ?? toolForStep(step, mcpTools)?.inputSchema
    const input = parameterError(
      step.input,
      inputSchema,
      parameterDrafts[`${step.id}:input`],
      step.inputFrom
        ? true
        : step.kind === "plugin-action" && step.evidenceInput
          ? [step.evidenceInput.field]
          : false,
      step.enabled
    )
    const config =
      step.kind === "plugin-action"
        ? parameterError(
            step.config ?? {},
            action?.configSchema,
            parameterDrafts[`${step.id}:config`],
            false,
            step.enabled
          )
        : undefined
    return input || config ? [{ id: step.id, name: step.name, message: input ?? config }] : []
  })
  const invalidParameters = stepErrors.length > 0 || profileErrors.length > 0
  const rawDirty = value.steps.some(
    (step) =>
      isFlowOutputStep(step) &&
      (parameterDrafts[`${step.id}:input`]?.dirty ||
        (step.kind === "plugin-action" && parameterDrafts[`${step.id}:config`]?.dirty))
  )
  useEffect(() => {
    onEditorStateChange?.({ valid: !invalidParameters, dirty: rawDirty })
  }, [invalidParameters, rawDirty, onEditorStateChange])
  const forgetStepDraft = (id: string) =>
    setParameterDrafts((old) =>
      Object.fromEntries(Object.entries(old).filter(([key]) => !key.startsWith(`${id}:`)))
    )
  const selectedId = value.steps.some((step) => step.id === selected)
    ? selected
    : (value.steps.find((step) => step.enabled)?.id ?? value.steps[0]?.id)
  const update = (patch: Partial<FlowDefinition>) =>
    onChange({ ...value, ...patch } as FlowDefinition)
  const add = (kind: FlowStep["kind"]) => {
    const id = flowDraftId("step")
    const step = stepOfKind(
      { id, name: kinds[kind], enabled: true, kind: "agent", prompt: "完成本步骤的任务" },
      kind
    )
    update({ steps: [...value.steps, step] })
    setSelected(id)
  }
  const stepChange = (index: number, step: FlowStep) =>
    update({ steps: value.steps.map((old, at) => (at === index ? step : old)) })
  const move = (index: number, offset: number) => {
    const steps = [...value.steps]
    const moved = steps[index]
    steps[index] = steps[index + offset]
    steps[index + offset] = moved
    update({ steps })
  }
  const feature = catalog.features.find((item) => item.id === value.feature)
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-5" aria-label="流程编辑器">
      {profileErrors.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-xs text-destructive"
        >
          <p>当前配置不符合文本模式，保存前请手动修正；已有步骤不会自动删除。</p>
          <ul>
            {profileErrors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      {stepErrors.length > 0 && (
        <div
          role="alert"
          className="space-y-1 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs"
        >
          <p>请修正参数后再保存或运行：</p>
          {stepErrors.map((item) => (
            <button
              type="button"
              key={item.id}
              className="block text-left text-destructive underline"
              onClick={() => setSelected(item.id)}
            >
              {item.name}：{item.message}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
        <p className="text-xs font-medium text-muted-foreground">01 · 定义这次任务</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field title="流程名称">
            <input
              className={field}
              value={value.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          </Field>
          {value.schemaVersion === 1 ? (
            <Field title="所属插件">
              <select
                className={field}
                value={value.plugin}
                onChange={(e) => update({ plugin: e.target.value })}
              >
                <option value="">请选择已授权插件</option>
                {!catalog.plugins.some((p) => p.id === value.plugin) && value.plugin && (
                  <option value={value.plugin}>{value.plugin}（不可用）</option>
                )}
                {catalog.plugins.map((plugin) => (
                  <option key={plugin.id} value={plugin.id} disabled={!plugin.authorized}>
                    {plugin.name}
                    {!plugin.authorized ? "（未授权）" : ""}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div className="rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">由应用运行</p>
              <p className="mt-1 leading-5">
                为每一步选择技能、模型、工具或插件操作。需要的插件和服务应先获得授权。
              </p>
            </div>
          )}
        </div>
        {value.schemaVersion === 2 && (
          <div className="space-y-2">
            <Field title="执行模式">
              <select
                className={field}
                value={filesOnly ? "workspace-files-v1" : promptOnly ? "prompt-only-v1" : "normal"}
                onChange={(event) =>
                  onChange({
                    ...value,
                    execution:
                      event.target.value === "prompt-only-v1" || event.target.value === "workspace-files-v1"
                        ? { kind: "host", profile: event.target.value }
                        : { kind: "host" }
                  })
                }
              >
                <option value="normal">普通模式（默认）</option>
                <option value="workspace-files-v1">文件副本模式（完成后确认写回）</option>
          <option value="prompt-only-v1">助手只处理文本（保留项目检查）</option>
              </select>
            </Field>
            {filesOnly && <p className="text-xs leading-5 text-muted-foreground">导入完整项目副本（包含 ignored 输入，最多 2048 项/64 MiB，拒绝链接与超限项目）。Agent 仅有固定虚拟文件工具；检查在临时副本中真实执行，必须保持输入不变。完成后需另行审阅、导出或确认写回。当前不支持动态 Mods 组件策略。</p>}
            {promptOnly && (
              <p className="text-xs leading-5 text-muted-foreground">
                Agent 仅处理任务与前序文本，不提供文件访问、业务工具、Skill、MCP 或动态组件能力。
                仅支持顺序 Agent、运行检查与人工确认步骤；宿主强制检查继续生效。
                只有完整证据通过重新核验时才可续跑，旧记录不会自动获得恢复资格。
              </p>
            )}
          </div>
        )}
        <Field title="任务目标">
          <textarea
            className={field}
            rows={3}
            value={value.goal}
            onChange={(e) => update({ goal: e.target.value })}
          />
        </Field>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {value.schemaVersion === 1
            ? "这个旧版流程继续使用原插件的权限设置。"
            : "保存只记录配置，不执行任务。"}
          插件动作可来自不同已授权插件；每个步骤独立选择执行者、输入和模型。
        </p>
        <details
          className="rounded-lg bg-muted/30 p-3"
          open={value.steps.some((step) => step.kind === "autobiz-stage")}
        >
          <summary className="cursor-pointer text-xs font-medium">
            {value.schemaVersion === 1 ? "项目阶段与运行限制" : "运行限制"}
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {value.schemaVersion === 1 && (
              <>
                <Field title="Autobiz Feature">
                  <select
                    className={field}
                    value={value.feature ?? ""}
                    onChange={(e) => {
                      const next = catalog.features.find((item) => item.id === e.target.value)
                      update({ feature: next?.id, stageStart: next?.checkpoint })
                    }}
                  >
                    <option value="">不关联 AutoBiz 需求</option>
                    {value.feature && !feature && (
                      <option value={value.feature}>{value.feature}（当前项目不可用）</option>
                    )}
                    {catalog.features.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id} · {item.checkpoint}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>本次起始阶段：{value.stageStart || "尚未选择"}</p>
                  {feature && feature.checkpoint !== value.stageStart && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => update({ stageStart: feature.checkpoint })}
                    >
                      使用当前阶段 {feature.checkpoint}
                    </Button>
                  )}
                  <p>阶段推进只能放在最后，通过宿主验收后推进一个合法阶段。</p>
                </div>
              </>
            )}
            <Field title="最长运行时间（分钟）">
              <input
                className={field}
                type="number"
                min={1}
                max={60}
                value={value.timeoutMs / 60000}
                onChange={(e) => update({ timeoutMs: Number(e.target.value) * 60000 })}
              />
            </Field>
            <Field title="最多步骤执行次数">
              <input
                className={field}
                type="number"
                min={1}
                max={256}
                value={value.maxExecutions}
                onChange={(e) => update({ maxExecutions: Number(e.target.value) })}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            总运行时间包含等待人工确认的时间，到达上限后流程停止。
          </p>
        </details>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">02 · 组合执行步骤</h3>
          <span className="text-xs text-muted-foreground">
            {value.steps.filter((step) => step.enabled).length} 个启用 / {value.steps.length} 个步骤
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="步骤组件库">
          {(Object.keys(kinds) as FlowStep["kind"][])
            .filter((kind) => value.schemaVersion === 1 || kind !== "autobiz-stage")
            .map((kind) => {
              const Icon = icons[kind]
              return (
                <Button
                  key={kind}
                  type="button"
                  variant="outline"
                  className="h-auto min-w-0 flex-col gap-2 rounded-xl px-2 py-3 text-xs"
                  disabled={value.steps.length >= 64}
                  onClick={() => add(kind)}
                  aria-label={`添加${kinds[kind]}`}
                >
                  <Icon className="size-4 text-primary" aria-hidden="true" />
                  {kinds[kind]}
                </Button>
              )
            })}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          点击组件添加步骤，点击步骤卡片配置。按从上到下的顺序执行；用箭头调整先后。
        </p>
        <p className="text-xs text-muted-foreground">
          Agent
          任务可选择角色与模型；运行检查由宿主运行项目脚本或验收器。回退会重新执行修复及后续检查，不撤销文件改动。
        </p>
        <ol className="relative space-y-3 border-l-2 border-border/60 pl-4" aria-label="步骤顺序">
          {value.steps.map((step, index) => (
            <li
              key={step.id}
              data-flow-step={step.id}
              className={`relative min-w-0 rounded-xl border shadow-sm transition-colors ${selectedId === step.id ? "border-primary/40 bg-card ring-2 ring-primary/5" : step.enabled ? "bg-card" : "bg-muted/20"}`}
            >
              <fieldset className="min-w-0" aria-label={`步骤 ${index + 1}`}>
                <div className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
                  <button
                    type="button"
                    className="flex min-w-0 basis-full flex-1 sm:basis-40 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`配置步骤：${step.name}`}
                    aria-expanded={selectedId === step.id}
                    onClick={() => setSelected(step.id)}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-semibold text-primary">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {step.name || "未命名步骤"}
                      </span>
                      <span className="block truncate pt-1 text-xs text-muted-foreground">
                        {kinds[step.kind]}
                        {!step.enabled
                          ? " · 已停用"
                          : step.kind === "agent" || step.kind === "skill"
                            ? ` · ${catalog.models.find((m) => m.id === step.modelId)?.name ?? (step.modelRole ? `组合分工 ${step.modelRole}` : "跟随默认模型")}`
                            : step.kind === "check"
                              ? ` · ${checks[step.check]}`
                              : ""}
                      </span>
                    </span>
                    <ChevronDown
                      className={`size-4 shrink-0 text-muted-foreground transition-transform ${selectedId === step.id ? "rotate-180" : ""}`}
                      aria-hidden="true"
                    />
                  </button>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={step.enabled}
                        onChange={(e) => stepChange(index, { ...step, enabled: e.target.checked })}
                      />
                      启用步骤
                    </label>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label="上移步骤"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label="下移步骤"
                      disabled={index === value.steps.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label="删除步骤"
                      onClick={() => {
                        if (
                          isFlowOutputStep(step) &&
                          !window.confirm("删除步骤会丢弃它的参数和未完成草稿，是否继续？")
                        )
                          return
                        forgetStepDraft(step.id)
                        update({ steps: value.steps.filter((_, at) => at !== index) })
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                {selectedId === step.id && (
                  <div className="space-y-4 border-t px-4 py-4 sm:px-5" data-flow-step-settings>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field title="步骤名称">
                        <input
                          className={field}
                          value={step.name}
                          onChange={(e) => stepChange(index, { ...step, name: e.target.value })}
                        />
                      </Field>
                      <Field title="步骤类型">
                        <select
                          className={field}
                          value={step.kind}
                          onChange={(e) => {
                            if (
                              isFlowOutputStep(step) &&
                              !window.confirm("更换步骤类型会丢弃当前类型的参数和草稿，是否继续？")
                            )
                              return
                            forgetStepDraft(step.id)
                            stepChange(index, stepOfKind(step, e.target.value as FlowStep["kind"]))
                          }}
                        >
                          {Object.entries(kinds)
                            .filter(
                              ([kind]) => value.schemaVersion === 1 || kind !== "autobiz-stage"
                            )
                            .map(([id, name]) => (
                              <option key={id} value={id}>
                                {name}
                              </option>
                            ))}
                        </select>
                      </Field>
                    </div>
                    {"prompt" in step && (
                      <Field title={step.kind === "approval" ? "确认说明" : "步骤目标"}>
                        <textarea
                          className={field}
                          rows={2}
                          value={step.prompt}
                          onChange={(e) => stepChange(index, { ...step, prompt: e.target.value })}
                        />
                      </Field>
                    )}
                    {step.kind === "skill" && (
                      <div className="space-y-2 rounded-xl border bg-muted/20 p-3">
                        <Field title="使用哪个技能">
                          <select
                            className={field}
                            value={JSON.stringify(step.skill)}
                            onChange={(event) => {
                              const skill = catalog.skills?.find(
                                (item) =>
                                  JSON.stringify({
                                    id: item.id,
                                    name: item.name,
                                    digest: item.digest
                                  }) === event.target.value
                              )
                              if (skill)
                                stepChange(index, {
                                  ...step,
                                  skill: { id: skill.id, name: skill.name, digest: skill.digest }
                                })
                            }}
                          >
                            <option value={JSON.stringify(step.skill)}>
                              {step.skill.name
                                ? `${step.skill.name} · 所选来源（运行前核对）`
                                : "请选择技能"}
                            </option>
                            {catalog.skills?.map((skill) => (
                              <option
                                key={skill.id}
                                value={JSON.stringify({
                                  id: skill.id,
                                  name: skill.name,
                                  digest: skill.digest
                                })}
                              >
                                {skill.name} · {skill.owner ?? skill.id}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <p className="text-xs leading-5 text-muted-foreground">
                          助手会按照所选技能完成这一步，使用下方指定的模型。技能仍受助手组合
                          和项目权限限制；技能更新或移除后需要重新选择。
                        </p>
                      </div>
                    )}
                    {isFlowOutputStep(step) && (
                      <div className="space-y-3 rounded-xl border bg-muted/20 p-3">
                        {step.kind === "mcp-tool" && (
                          <div className="space-y-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={mcpLoading || !onLoadMcpTools}
                                onClick={onLoadMcpTools}
                              >
                                {mcpLoading ? "正在连接并读取…" : "加载 MCP 工具目录"}
                              </Button>
                              <span className="text-xs text-muted-foreground">
                                仅点击时连接服务；全局初始化可能连接其他已启用来源。
                              </span>
                            </div>
                            {mcpError && (
                              <p role="alert" className="text-xs text-destructive">
                                {mcpError}
                              </p>
                            )}
                            <Field title="MCP 服务与工具">
                              <select
                                className={field}
                                value={JSON.stringify([
                                  step.provider,
                                  step.toolName,
                                  step.schemaDigest
                                ])}
                                onChange={(event) => {
                                  const tool = mcpTools?.find(
                                    (item) =>
                                      JSON.stringify([
                                        item.provider,
                                        item.toolName,
                                        item.schemaDigest
                                      ]) === event.target.value
                                  )
                                  if (tool && !tool.unavailableReason)
                                    stepChange(index, {
                                      ...step,
                                      provider: tool.provider,
                                      toolName: tool.toolName,
                                      schemaDigest: tool.schemaDigest
                                    })
                                }}
                              >
                                <option
                                  value={JSON.stringify([
                                    step.provider,
                                    step.toolName,
                                    step.schemaDigest
                                  ])}
                                >
                                  {step.toolName
                                    ? `${step.provider.name} / ${step.toolName} · 所选来源（运行前核对）`
                                    : "先加载目录，再选择工具"}
                                </option>
                                {mcpTools?.map((tool) => (
                                  <option
                                    key={`${tool.provider.id}:${tool.toolName}`}
                                    disabled={!!tool.unavailableReason}
                                    value={JSON.stringify([
                                      tool.provider,
                                      tool.toolName,
                                      tool.schemaDigest
                                    ])}
                                  >
                                    {tool.provider.name} / {tool.toolName}
                                    {tool.unavailableReason ? `（${tool.unavailableReason}）` : ""}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            {mcpTools?.length === 0 && (
                              <p className="text-xs text-muted-foreground">
                                没有可用工具。请检查外部服务是否已开启，以及当前助手组合是否允许使用它。
                              </p>
                            )}
                            {mcpTools
                              ?.filter((tool) => tool === toolForStep(step, mcpTools))
                              .map((tool) => (
                                <details key={tool.schemaDigest} className="text-xs">
                                  <summary className="cursor-pointer">
                                    查看工具说明与参数格式
                                  </summary>
                                  <p className="my-2 whitespace-pre-wrap">{tool.description}</p>
                                  <pre className="max-h-56 overflow-auto rounded-lg bg-muted p-2">
                                    {JSON.stringify(tool.inputSchema ?? {}, null, 2)}
                                  </pre>
                                </details>
                              ))}
                            <p className="text-xs leading-5 text-muted-foreground">
                              每次运行仅调用一次，不自动重试；后续失败不能回退跨过此步骤。取消或超时不代表远端操作已撤销。
                            </p>
                          </div>
                        )}
                        {step.kind === "plugin-action" && (
                          <>
                            <Field title="动作提供者">
                              <select
                                className={field}
                                value={JSON.stringify([
                                  step.pluginId,
                                  step.plugin,
                                  step.digest,
                                  step.actionId
                                ])}
                                onChange={(event) => {
                                  const action = catalog.actions?.find(
                                    (item) =>
                                      JSON.stringify([
                                        item.pluginId,
                                        item.plugin,
                                        item.digest,
                                        item.actionId
                                      ]) === event.target.value
                                  )
                                  if (action)
                                    stepChange(index, {
                                      ...step,
                                      pluginId: action.pluginId,
                                      plugin: action.plugin,
                                      digest: action.digest,
                                      actionId: action.actionId,
                                      name: action.name
                                    })
                                }}
                              >
                                <option
                                  value={JSON.stringify([
                                    step.pluginId,
                                    step.plugin,
                                    step.digest,
                                    step.actionId
                                  ])}
                                >
                                  {step.actionId
                                    ? `${step.plugin} / ${step.actionId}`
                                    : "选择不同插件导出的动作"}
                                </option>
                                {catalog.actions?.map((action) => (
                                  <option
                                    key={`${action.pluginId}:${action.actionId}`}
                                    value={JSON.stringify([
                                      action.pluginId,
                                      action.plugin,
                                      action.digest,
                                      action.actionId
                                    ])}
                                  >
                                    {action.plugin} · {action.name}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            {!catalog.actions?.length && (
                              <p className="text-xs text-muted-foreground">
                                没有可选操作。请先添加支持分步调用的插件并授权；旧项目插件仍可从原来的项目入口使用。
                              </p>
                            )}
                          </>
                        )}
                        {(step.kind === "plugin-action"
                          ? (["input", "config"] as const)
                          : (["input"] as const)
                        ).map((kind) => {
                          const key = `${step.id}:${kind}`
                          const action = actionForStep(step, catalog.actions)
                          const tool = toolForStep(step, mcpTools)
                          const schema =
                            kind === "config"
                              ? action?.configSchema
                              : (action?.inputSchema ?? tool?.inputSchema)
                          return (
                            <FlowParameterEditor
                              key={kind}
                              title={kind === "input" ? "动作输入" : "动作配置"}
                              value={
                                kind === "config" && step.kind === "plugin-action"
                                  ? (step.config ?? {})
                                  : step.input
                              }
                              schema={schema}
                              draft={parameterDrafts[key]}
                              allowMissing={
                                kind === "input"
                                  ? step.inputFrom
                                    ? true
                                    : step.kind === "plugin-action" && step.evidenceInput
                                      ? [step.evidenceInput.field]
                                      : false
                                  : false
                              }
                              validateSchema={step.enabled}
                              sourceMissing={
                                step.kind === "plugin-action"
                                  ? !!step.actionId && !action
                                  : !!step.toolName && !tool
                              }
                              onChange={(next) => stepChange(index, { ...step, [kind]: next })}
                              onDraftChange={(next) =>
                                setParameterDrafts((old) => ({ ...old, [key]: next }))
                              }
                            />
                          )
                        })}
                        <Field title="接收前置步骤输出">
                          <select
                            className={field}
                            value={
                              step.kind === "plugin-action" && step.evidenceInput
                                ? "__evidence"
                                : (step.inputFrom?.stepId ?? "")
                            }
                            onChange={(event) =>
                              stepChange(index, {
                                ...step,
                                inputFrom:
                                  event.target.value && event.target.value !== "__evidence"
                                    ? { stepId: event.target.value }
                                    : undefined,
                                ...(step.kind === "plugin-action"
                                  ? {
                                      evidenceInput:
                                        event.target.value === "__evidence"
                                          ? { field: "text" }
                                          : undefined
                                    }
                                  : {})
                              })
                            }
                          >
                            <option value="">不绑定，仅使用上方输入</option>
                            {step.kind === "plugin-action" && (
                              <option value="__evidence">本次执行结果（有效检视与测试证据）</option>
                            )}
                            {value.steps
                              .slice(0, index)
                              .filter((item) => item.enabled && isFlowOutputStep(item))
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name}
                                </option>
                              ))}
                          </select>
                        </Field>
                        {step.kind === "plugin-action" && step.evidenceInput && (
                          <Field title="执行结果写入字段">
                            <input
                              className={field}
                              value={step.evidenceInput.field}
                              onChange={(event) =>
                                stepChange(index, {
                                  ...step,
                                  inputFrom: undefined,
                                  evidenceInput: { field: event.target.value }
                                })
                              }
                              placeholder="text"
                            />
                          </Field>
                        )}
                        {step.kind === "plugin-action" && step.evidenceInput && (
                          <p className="text-xs text-muted-foreground">
                            此字段将在运行时由实际执行结果替换，包含当前有效检视与原生测试回执；不使用常量作为结果后备。
                          </p>
                        )}
                        {step.inputFrom && (
                          <>
                            <Field title="输出来源路径">
                              <select
                                className={field}
                                value={step.inputFrom.path ?? ""}
                                onChange={(event) => {
                                  stepChange(index, {
                                    ...step,
                                    inputFrom: {
                                      stepId: step.inputFrom!.stepId,
                                      path: event.target.value || undefined
                                    }
                                  })
                                }}
                              >
                                <option value="">完整输出对象</option>
                                {(() => {
                                  const paths = outputPaths.get(step.inputFrom!.stepId) ?? []
                                  return (
                                    <>
                                      {step.inputFrom.path &&
                                        !paths.some(
                                          (item) => item.path === step.inputFrom?.path
                                        ) && (
                                          <option value={step.inputFrom.path}>
                                            高级路径：{step.inputFrom.path}（运行时核对）
                                          </option>
                                        )}
                                      {paths.map((item) => (
                                        <option key={item.path} value={item.path}>
                                          {item.label}
                                        </option>
                                      ))}
                                    </>
                                  )
                                })()}
                              </select>
                            </Field>
                            <details
                              className="rounded-lg bg-muted/30 p-3"
                              open={
                                !!step.inputFrom.path &&
                                !(outputPaths.get(step.inputFrom.stepId) ?? []).some(
                                  (item) => item.path === step.inputFrom?.path
                                )
                              }
                            >
                              <summary className="cursor-pointer text-xs">高级输出路径</summary>
                              <div className="mt-3">
                                <Field title="输出字段路径（JSON Pointer，可留空）">
                                  <input
                                    className={field}
                                    value={step.inputFrom.path ?? ""}
                                    placeholder="/result"
                                    onChange={(event) =>
                                      stepChange(index, {
                                        ...step,
                                        inputFrom: {
                                          stepId: step.inputFrom!.stepId,
                                          path: event.target.value || undefined
                                        }
                                      })
                                    }
                                  />
                                </Field>
                              </div>
                            </details>
                          </>
                        )}
                        <p className="text-xs leading-5 text-muted-foreground">
                          仅接收有效前置结果中的对象；上方固定输入覆盖同名字段。实际执行仍受所属
                          Mods 与来源权限约束。
                        </p>
                      </div>
                    )}
                    {(step.kind === "agent" || step.kind === "skill") && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field title="执行助手">
                          <select
                            className={field}
                            value={step.agentType ?? ""}
                            onChange={(e) =>
                              stepChange(index, { ...step, agentType: e.target.value || undefined })
                            }
                          >
                            <option value="">使用聊天默认助手</option>
                            {step.agentType &&
                              !catalog.agents.some((a) => a.id === step.agentType) && (
                                <option value={step.agentType}>{step.agentType}（不可用）</option>
                              )}
                            {catalog.agents.map((agent) => (
                              <option key={agent.id} value={agent.id}>
                                {agent.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field title="模型选择方式">
                          <select
                            className={field}
                            value={step.modelId ? "fixed" : step.modelRole ? "role" : "default"}
                            onChange={(event) =>
                              stepChange(index, {
                                ...step,
                                modelId:
                                  event.target.value === "fixed"
                                    ? catalog.models[0]?.id
                                    : undefined,
                                modelRole: event.target.value === "role" ? "review" : undefined
                              })
                            }
                          >
                            <option value="default">使用默认模型</option>
                            <option value="role">助手组合中的模型分工</option>
                            <option value="fixed" disabled={!catalog.models.length}>
                              指定模型
                            </option>
                          </select>
                        </Field>
                        {step.modelId ? (
                          <Field title="模型">
                            <select
                              className={field}
                              value={step.modelId}
                              onChange={(event) =>
                                stepChange(index, {
                                  ...step,
                                  modelId: event.target.value,
                                  modelRole: undefined
                                })
                              }
                            >
                              {!catalog.models.some((model) => model.id === step.modelId) && (
                                <option value={step.modelId}>{step.modelId}（不可用）</option>
                              )}
                              {catalog.models.map((model) => (
                                <option key={model.id} value={model.id}>
                                  {model.name}
                                </option>
                              ))}
                            </select>
                          </Field>
                        ) : step.modelRole ? (
                          <Field title="助手组合中的模型分工">
                            <input
                              className={field}
                              value={step.modelRole}
                              placeholder="implementation 或 review"
                              onChange={(event) =>
                                stepChange(index, {
                                  ...step,
                                  modelRole: event.target.value || undefined,
                                  modelId: undefined
                                })
                              }
                            />
                          </Field>
                        ) : null}
                        <p className="text-xs text-muted-foreground sm:col-span-2">
                          模型依次按以下设置选择：本步骤指定的模型 → 组合中的分工模型 → 执行助手的模型 → 组合默认模型 →
                          应用默认模型。使用分工模型前，请先在助手组合中设置。
                        </p>
                        {step.modelId && step.modelRole && (
                          <p className="text-xs text-amber-600 sm:col-span-2">
                            旧版本同时保存了角色和指定模型，当前按指定模型执行；切换选择方式会清除另一项。
                          </p>
                        )}
                        {step.agentType && (
                          <p className="text-xs text-muted-foreground sm:col-span-2">
                            {catalog.agents.find((a) => a.id === step.agentType)?.description}
                          </p>
                        )}
                      </div>
                    )}
                    {step.kind === "check" && (
                      <Field title="检查内容">
                        <select
                          className={field}
                          value={step.check}
                          onChange={(e) =>
                            stepChange(index, {
                              ...step,
                              check: e.target.value as typeof step.check
                            })
                          }
                        >
                          {Object.entries(checks)
                            .filter(
                              ([id]) =>
                                value.schemaVersion === 1 || id === "unit-test" || id === "e2e"
                            )
                            .map(([id, name]) => (
                              <option key={id} value={id}>
                                {name}
                              </option>
                            ))}
                        </select>
                      </Field>
                    )}
                    {step.kind === "autobiz-stage" ? (
                      <p className="text-xs text-muted-foreground">
                        此步骤必须是最后启用的步骤，完成所有必需检查后仅推进一个阶段。失败即停止。
                      </p>
                    ) : (
                      <details>
                        <summary className="cursor-pointer text-sm">
                          条件、成功路线与失败回退
                          {step.when || step.onSuccess || step.onFailure ? "（已配置）" : ""}
                        </summary>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <Field title="执行条件">
                            <select
                              className={field}
                              value={step.when?.stepId ?? ""}
                              onChange={(e) =>
                                stepChange(index, {
                                  ...step,
                                  when: e.target.value
                                    ? {
                                        stepId: e.target.value,
                                        outcome: step.when?.outcome ?? "passed"
                                      }
                                    : undefined
                                })
                              }
                            >
                              <option value="">始终执行</option>
                              {step.when &&
                                !value.steps
                                  .slice(0, index)
                                  .some((s) => s.id === step.when?.stepId) && (
                                  <option value={step.when.stepId}>
                                    {step.when.stepId}（依赖无效）
                                  </option>
                                )}
                              {value.steps.slice(0, index).map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                          </Field>
                          {step.when && (
                            <Field title="条件结果">
                              <select
                                className={field}
                                value={step.when.outcome}
                                onChange={(e) =>
                                  stepChange(index, {
                                    ...step,
                                    when: {
                                      stepId: step.when!.stepId,
                                      outcome: e.target.value as "passed" | "failed"
                                    }
                                  })
                                }
                              >
                                <option value="passed">业务通过时</option>
                      <option value="failed">未通过时</option>
                              </select>
                            </Field>
                          )}
                          <Field title="成功后">
                            <select
                              className={field}
                              value={step.onSuccess ?? ""}
                              onChange={(e) =>
                                stepChange(index, {
                                  ...step,
                                  onSuccess: e.target.value || undefined
                                })
                              }
                            >
                              <option value="">下一个启用步骤</option>
                              {step.onSuccess &&
                                !value.steps
                                  .slice(index + 1)
                                  .some((s) => s.id === step.onSuccess) && (
                                  <option value={step.onSuccess}>
                                    {step.onSuccess}（目标无效）
                                  </option>
                                )}
                              {value.steps.slice(index + 1).map((s) => (
                                <option key={s.id} value={s.id} disabled={!s.enabled}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                          </Field>
                  <Field title="未通过时">
                            <select
                              className={field}
                              value={step.onFailure?.stepId ?? ""}
                              disabled={step.kind === "approval" || step.kind === "mcp-tool"}
                              onChange={(e) =>
                                stepChange(index, {
                                  ...step,
                                  onFailure: e.target.value
                                    ? {
                                        stepId: e.target.value,
                                        maxRetries: step.onFailure?.maxRetries ?? 1
                                      }
                                    : undefined
                                })
                              }
                            >
                              <option value="">停止流程</option>
                              {step.onFailure &&
                                !value.steps.some((s) => s.id === step.onFailure?.stepId) && (
                                  <option value={step.onFailure.stepId}>
                                    {step.onFailure.stepId}（目标无效）
                                  </option>
                                )}
                              {value.steps.map(
                                (s, at) =>
                                  at !== index && (
                                    <option
                                      key={s.id}
                                      value={s.id}
                                      disabled={
                                        !s.enabled ||
                                        (at < index &&
                                          value.steps
                                            .slice(at, index + 1)
                                            .some(
                                              (item) => item.enabled && item.kind === "mcp-tool"
                                            ))
                                      }
                                    >
                                      {at < index ? "回退：" : "替代："}
                                      {s.name}
                                    </option>
                                  )
                              )}
                            </select>
                          </Field>
                          {step.onFailure && (
                            <Field title="最多失败转向次数">
                              <input
                                className={field}
                                type="number"
                                min={1}
                                max={10}
                                value={step.onFailure.maxRetries}
                                onChange={(e) =>
                                  stepChange(index, {
                                    ...step,
                                    onFailure: {
                                      stepId: step.onFailure!.stepId,
                                      maxRetries: Number(e.target.value)
                                    }
                                  })
                                }
                              />
                            </Field>
                          )}
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          执行异常、权限拒绝、取消或未知结果将停止流程，不进入业务失败路线。
                        </p>
                      </details>
                    )}
                  </div>
                )}
              </fieldset>
            </li>
          ))}
        </ol>
        <Button
          type="button"
          variant="outline"
          disabled={value.steps.length >= 64}
          onClick={() => add("agent")}
        >
          <Plus className="mr-2 size-4" aria-hidden="true" />
          添加步骤
        </Button>
        <p className="text-xs text-muted-foreground">
          {value.steps.length}/64 步。删除、停用或移动被引用的步骤后，请修正提示的路线与依赖。
        </p>
      </div>
    </fieldset>
  )
})
