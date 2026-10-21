import { createAuthoringSourceBundle } from "./authoring-bundle"

/** Executable decision scaffold, deliberately without an invented graph or a state writer. */
export function createStateExtensionTemplate(input: {
  id: string
  name: string
  instruction: string
}) {
  const id = JSON.stringify(input.id)
  const title = JSON.stringify(input.name)
  const instruction = JSON.stringify(input.instruction)
  const source = `import type { Register, JsonObject } from "claude-code"
// Replace only after reviewing the original graph, Hooks, configuration, knowledge and writer.
const policy: { confirmed: boolean; transitions: Array<{ from: string; event: string; to: string; requiredChecks: string[] }> } = { confirmed: false, transitions: [] }
function decide(input: JsonObject): JsonObject {
  const details = { instruction: ${instruction}, execution: "unverified", writerBound: false }
  if (!policy.confirmed) return { ...details, decision: "hold", reason: "AUTHOR_CONFIRMATION_REQUIRED" }
  if (Object.keys(input).some(key => !["currentState", "event"].includes(key)) || typeof input.currentState !== "string" || typeof input.event !== "string")
    return { ...details, decision: "hold", reason: "INVALID_DECISION_INPUT" }
  const matches = policy.transitions.filter(edge => edge.from === input.currentState && edge.event === input.event)
  if (matches.length !== 1) return { ...details, decision: "hold", reason: "EDGE_MISSING_OR_AMBIGUOUS" }
  const edge = matches[0]!
  return { ...details, decision: "proposal", from: edge.from, to: edge.to, requiredChecks: edge.requiredChecks, reason: "ORIGINAL_WRITER_AND_CHECKS_REQUIRED" }
}
export const register: Register<${id}> = (on) => {
  on("session.start", async ($, event, next) => {
    await $.command.register({ name: ${id}, description: ${title} + "：可执行决策骨架，未绑定业务写入器", immediate: true })
    return next(event)
  })
  on("command.run", { command: ${id} }, (_sdk, event) => {
    let input: JsonObject = {}
    try {
      const parsed: unknown = JSON.parse(event.args || "{}")
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as JsonObject
    } catch { /* Default preview stays a hold, never a successful commit. */ }
    return { text: JSON.stringify(decide(input)) }
  })
  on.capability({
    apiVersion: "devclaw.capability/v1", id: "state-decision", version: "1.0.0", title: ${title}, scope: "conversation",
    stateSchema: { type: "object" },
    actions: [{ id: "evaluate", title: "评估状态决策（不提交）", inputSchema: { type: "object", additionalProperties: false, properties: { currentState: { type: "string" }, event: { type: "string" } }, required: ["currentState", "event"] }, outputSchema: { type: "object" }, requiredPermissions: [], cancellable: true, idempotency: "keyed" }]
  }, { act: (_sdk, event) => decide(event.input) })
}
`
  const plan = {
    schemaVersion: 1,
    kind: "state-extension-migration-plan",
    status: "author-confirmation-required",
    executableDecision: true,
    stateMigration: "not-migrated",
    writerBound: false,
    execution: "unverified",
    originalSourceDigest: null,
    fullPluginRoute: {
      tool: "mod_business",
      actions: ["inspect", "save", "preview", "request_trial", "request_review"],
      namespace: `mods/business/${input.id}/`,
      requiresOriginalKernel: true
    },
    graph: { confirmed: false, transitions: [] },
    preserve: ["original-state-writer", "hooks", "knowledge", "configuration", "artifact-checks"],
    next: [
      "inspect-original-source",
      "confirm-original-graph",
      "bind-existing-writer",
      "run-native-approved-tests"
    ],
    testEntry: {
      command: input.id,
      args: '{"currentState":"unmapped","event":"inspect"}',
      expectedDecision: "hold"
    }
  }
  return createAuthoringSourceBundle([
    {
      path: "plugin.json",
      text:
        JSON.stringify(
          {
            name: input.id,
            version: "0.1.0",
            description: input.name + "：决策骨架，状态未迁移",
            mods: "mods/manifest.json"
          },
          null,
          2
        ) + "\n"
    },
    {
      path: "mods/manifest.json",
      text:
        JSON.stringify(
          {
            apiVersion: "cmb.mods/v2",
            id: input.id,
            claw: {
              componentsVersion: 1,
              components: [
                {
                  id: "main",
                  name: input.name,
                  description: "可执行决策骨架；未绑定业务写入器，未迁移状态",
                  kind: "module",
                  entry: "main.ts",
                  dependsOn: [],
                  actionIds: []
                }
              ]
            }
          },
          null,
          2
        ) + "\n"
    },
    { path: "mods/main.ts", text: source },
    { path: "references/state-migration-plan.json", text: JSON.stringify(plan, null, 2) + "\n" },
    {
      path: "tests/state-decision-cases.json",
      text:
        JSON.stringify(
          {
            schemaVersion: 1,
            executed: false,
            cases: [
              {
                input: { currentState: "unmapped", event: "inspect" },
                expected: {
                  decision: "hold",
                  reason: "AUTHOR_CONFIRMATION_REQUIRED",
                  writerBound: false,
                  execution: "unverified"
                }
              }
            ]
          },
          null,
          2
        ) + "\n"
    },
    {
      path: "references/writer-binding.md",
      text: '# 原状态写入器绑定\n\n这是可执行决策骨架，未绑定业务写入器、未迁移状态。保留原插件全部 Hooks、知识、配置、产物检查及唯一状态写入器。既有 Host 状态继续由 Host 管理，无需强制迁移。\n\n先用 mod_business inspect_raw/read_raw_asset 核对原始源码和状态入口；未知状态图由作者明确确认后修改 mods/main.ts 的 policy。proposal 仅为决策建议，不是原生产校验通过、授权、实际状态或提交回执。\n\n绑定应在普通 Function Mod 动作中调用已有接口，例如 `await $.tool.call({tool: "实际发现的工具名称", ...actualInput})`，或 `await $.process.run([actualExecutable, actualOriginalWriter, ...actualArgs])`；实际参数须从原源码与工具目录核对，不能执行这些占位符。必须执行原 Hook/产物校验，沿用实际原生批准，按原 writer 的版本/摘要约束提交，再只读核对实际结果。SDK 调用直接写在事件处理器中。\n\n禁止用输入 passed:true、Mod 返回 proposal、process exitCode 或 platform 动作 succeeded 单独代替业务提交；未知结果先核对，不重放。state.set 的 ifVersion 仅为会话内 CAS；platform.publish 不是多文件事务，也不保证任意脚本隔离。\n'
    },
    {
      path: "references/business-assembly.md",
      text: "# 合并到完整业务插件\n\n纯函数试用通过不等于原业务插件状态迁移通过。先 mod_business inspect(pluginId) 取得真实 inspectionId/kernel，read_mod/read_asset 核对原 Hooks、知识、配置和唯一 writer。首次无业务目录先 inspect_raw，并按原生模块化确认得到实际 inspectionId；不伪造受审 kernel 或固定版本。\n\n用现有 mod_business save(id,name,revision,inspectionId,extensions,files) 保存独立扩展草稿：扩展 kind=function、entry=mods/business/<extensionId>/main.ts、resources 为该命名空间内实际资源、dependencies 按原依赖显式声明。将审核后的 Function Mod 移到这一命名空间，保留原 kernel 的 writer、Hooks、配置和知识；不要直接复制本纯包的 plugin.json 或 mods/manifest.json 覆盖原插件。原生解析器会检查命名空间和依赖，按结构化诊断修复。\n\n随后 preview 组合唯一实际 kernel source 与草稿 extensions，检查产物/知识/Hook诊断，再 request_trial 请求新的原生批准并执行原流程正反例。只有实际业务验收后再 request_review 准备安装/导出确认。没有 import_extension/create_extension 工具，不得虚构这些操作。\n"
    },
    {
      path: "references/state-extension-author.md",
      text: "---\nname: state-extension-author\ndescription: 核对原插件并完成状态决策扩展；保留原状态写入器及校验\n---\n读取 references/state-migration-plan.json 与 references/writer-binding.md。未知业务图先向作者确认，保留原 Hooks、知识、配置与状态入口。使用现有 mod_authoring save/check/request_trial，原生试用需用户批准。先运行 tests/state-decision-cases.json 中的 hold 样例，再补原 writer 的真实正反例；未实际运行不得将 execution 标为 verified。\n"
    },
    {
      path: "README.md",
      text: `# ${input.name}\n\n可执行决策骨架，未绑定业务写入器，未迁移状态，执行未验证。\n\n${input.instruction}\n\n通过现有 mod_authoring scaffold(kind:state-extension) 生成，save/check/request_trial 后在原生界面核对并批准试用。命令 /${input.id} {"currentState":"unmapped","event":"inspect"} 必须返回 hold。references/state-migration-plan.json 提供机器可读迁移任务与原源码摘要待绑定字段；tests/state-decision-cases.json 是未执行的测试入口。作者确认真实图后，已确认边也仅返回 proposal，原 writer 与业务校验必须另外绑定和实测。\n\n本候选不会读取秘密配置或修改原插件、原状态文件、Hooks、知识与产物。构建或决策回调通过不等于状态迁移成功，不新增专用平台 SDK。\n`
    }
  ])
}
