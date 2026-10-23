import { decide } from "./graph"

const apiVersion = "autobiz.function-state/v1"
const capabilityId = "autobiz-state"
const capabilityVersion = "1.0.0"
const feature = { type: "string", minLength: 1, maxLength: 128 }
const checkpoint = { type: "string", minLength: 1, maxLength: 80 }
const digest = { type: "string", minLength: 64, maxLength: 64 }
const requestKey = { type: "string", minLength: 1, maxLength: 100 }
const readSchema = {
  type: "object",
  additionalProperties: false,
  properties: { feature },
  required: ["feature"]
}
const checkSchema = {
  type: "object",
  additionalProperties: false,
  properties: { feature, to: checkpoint },
  required: ["feature", "to"]
}
const advanceSchema = {
  type: "object",
  additionalProperties: false,
  properties: { feature, to: checkpoint, expectedStateDigest: digest, requestKey },
  required: ["feature", "to", "expectedStateDigest", "requestKey"]
}
const reconcileSchema = {
  type: "object",
  additionalProperties: false,
  properties: { feature, requestKey },
  required: ["feature", "requestKey"]
}
const outputSchema = { type: "object", additionalProperties: true }

function stateTool(pluginName, operation) {
  return "mcp__" + pluginName.replace(/[^a-zA-Z0-9_-]/g, "_") + "__state_" + operation
}

function actionValue(receipt) {
  if (receipt.status === "succeeded") return receipt.value
  return {
    apiVersion,
    ok: false,
    status: receipt.status,
    errors: [receipt.error || "状态动作结果未知，请只读核对实际结果。"]
  }
}

function ownLegacyWriterCall(event, root) {
  if (!/^(?:execute|shell|bash|command)$/i.test(event.tool) || typeof event.command !== "string")
    return false
  // Only unambiguous direct calls. Reading a script or another plugin's same-named
  // program is unrelated; compound shell expressions remain subject to original policy.
  if (/[;|&`\r\n]/.test(event.command)) return false
  const tokens = event.command.match(/"[^"]*"|'[^']*'|[^\s]+/g) || []
  const normalized = (value) =>
    value
      .replace(/^["']|["']$/g, "")
      .replace(/\\/g, "/")
      .toLowerCase()
  const first = normalized(tokens[0] || "")
  const prefix = normalized(root).replace(/\/$/, "") + "/hooks/"
  const writers = ["update_checkpoint.py", "skip_node.py", "rollback_stage.py"].map(
    (name) => prefix + name
  )
  if (writers.includes(first)) return true
  if (!/(?:^|\/)(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?$/.test(first)) return false
  if (tokens.includes("-c") || tokens.includes("-m")) return false
  return tokens.slice(1, 8).some((token) => writers.includes(normalized(token)))
}

export function register(on) {
  let sequence = 0
  let sessionPolicyDigest = ""
  on("classic.PreSkillUse", async ($, event, next) => {
    const result = await next(event)
    if (event.plugin_name !== $.plugin.name) return result
    return {
      ...(result || {}),
      additionalContext: [
        ...((result && result.additionalContext) || []),
        "当前插件使用可组合状态 Mod。保留本 Skill 的知识、配置和业务产物要求；先调用当前插件注册的 state_read，按 workflow.stages 中匹配本技能的 inputs 读取上游文件，在本步骤产物中继承其实际需求与来源，不能只核对文件存在。状态推进调用 state_preflight、state_advance、state_reconcile。读取真实 feature 和有效 workflow.allowedNext 后选择明确下一状态；生成产物不等于推进成功。不要执行 Skill 旧正文中的 update_checkpoint.py、skip_node.py、rollback_stage.py，也不要直接修改 state.json 或 STATE.md。只有 committed 并再次读取一致才算推进成功；unknown 只读对账；源码或步骤契约变化时停止并重新创建受审候选。"
      ]
    }
  })
  on("session.start", async ($, event, next) => {
    await $.command.register({
      name: "autobiz-state-read",
      description: "读取真实 AutoBiz 状态；不修复、不推进"
    })
    await $.command.register({
      name: "autobiz-state-check",
      description: "检查有效组合图、产物契约和原 Hooks；不推进"
    })
    await $.command.register({
      name: "autobiz-state-advance",
      description: "按原产物门禁和明确请求推进；技术设计需人工确认"
    })
    await $.command.register({
      name: "autobiz-state-reconcile",
      description: "只读核对请求和物理提交记录；不重跑、不修复"
    })
    await $.tool.register({
      name: "state_read",
      description: "Read real feature state without repairs.",
      inputSchema: readSchema
    })
    await $.tool.register({
      name: "state_preflight",
      description: "Check the Mod edge and original validators without committing.",
      inputSchema: checkSchema
    })
    await $.tool.register({
      name: "state_advance",
      description:
        "Commit an exact Mod edge after original checks; design completion requires a native user question.",
      inputSchema: advanceSchema
    })
    await $.tool.register({
      name: "state_reconcile",
      description: "Read journal and physical receipt without replaying a write.",
      inputSchema: reconcileSchema
    })
    return next(event)
  })

  on.capability(
    {
      apiVersion: "devclaw.capability/v1",
      id: capabilityId,
      version: capabilityVersion,
      title: "AutoBiz 状态规则与受控推进",
      scope: "workspace",
      stateSchema: outputSchema,
      actions: [
        {
          id: "read",
          title: "读取状态",
          inputSchema: readSchema,
          outputSchema,
          requiredPermissions: ["process.run", "session.cwd"],
          cancellable: true,
          idempotency: "keyed"
        },
        {
          id: "preflight",
          title: "检查原阶段产物",
          inputSchema: checkSchema,
          outputSchema,
          requiredPermissions: ["process.run", "session.cwd"],
          cancellable: true,
          idempotency: "keyed"
        },
        {
          id: "advance",
          title: "校验并推进",
          inputSchema: advanceSchema,
          outputSchema,
          requiredPermissions: ["process.run", "session.cwd", "ui.ask", "tool.call"],
          cancellable: true,
          idempotency: "keyed"
        },
        {
          id: "reconcile",
          title: "只读核对实际提交",
          inputSchema: reconcileSchema,
          outputSchema,
          requiredPermissions: ["process.run", "session.cwd"],
          cancellable: true,
          idempotency: "keyed"
        }
      ]
    },
    {
      async act($, event) {
        // This exact callback is mandatory. Optional Hook recovery cannot produce a commit.
        const invoke = async (operation, input) => {
          const process = await $.process.run(
            [
              "python",
              "-I",
              "-B",
              "-X",
              "utf8",
              $.plugin.root + "/mods/business/autobiz.state-machine/adapter.py"
            ],
            {
              cwd: await $.session.cwd(),
              stdin: JSON.stringify({ apiVersion, operation, ...input }),
              timeoutMs: 120000
            }
          )
          const value = JSON.parse(process.stdout)
          if (
            value.apiVersion !== apiVersion ||
            typeof value.ok !== "boolean" ||
            (process.exitCode !== 0 && value.ok)
          )
            throw Error("AUTOBIZ_MOD_ADAPTER_PROTOCOL")
          // Only the selected feature crosses the bounded transport, never all projects.
          if (operation === "read") {
            if (!value.ok) return value
            const sourcePolicy = value.workflow && value.workflow.policyDigest
            const overlayPolicy = value.workflow && value.workflow.overlayDigest
            if (!/^[0-9a-f]{64}$/.test(sourcePolicy) || !/^[0-9a-f]{64}$/.test(overlayPolicy))
              throw Error("AUTOBIZ_MOD_POLICY_REQUIRED")
            const policy = sourcePolicy + ":" + overlayPolicy
            if (sessionPolicyDigest && sessionPolicyDigest !== policy)
              throw Error("AUTOBIZ_MOD_SOURCE_CHANGED_REOPEN_SESSION")
            sessionPolicyDigest = policy
            return {
              apiVersion,
              ok: value.ok,
              status: value.status,
              feature: value.feature,
              record: value.record,
              stateDigest: value.stateDigest,
              markdownDigest: value.markdownDigest,
              workflow: value.workflow
            }
          }
          if (value.stageChecks !== undefined) {
            const checks = value.stageChecks
            delete value.stageChecks
            value.stageChecksSummary = {
              kind: "summary",
              entries: Array.isArray(checks) ? checks.length : Object.keys(checks).length
            }
          }
          if (JSON.stringify(value).length > 12000) throw Error("AUTOBIZ_MOD_RESULT_TOO_LARGE")
          return value
        }
        const input = event.input
        if (event.action === "read") return invoke("read", { feature: input.feature })
        if (event.action === "reconcile")
          return invoke("reconcile", { feature: input.feature, requestKey: input.requestKey })
        const state = await invoke("read", { feature: input.feature })
        if (!state.ok) return state
        if (event.action === "advance" && state.stateDigest !== input.expectedStateDigest)
          return invoke("reconcile", {
            feature: input.feature,
            to: input.to,
            expectedStateDigest: input.expectedStateDigest,
            requestKey: input.requestKey,
            expectedWorkflowDigest: state.workflow.digest
          })
        const intent = decide(state.record, input.to, state.workflow)
        const prepared = await invoke("prepare", {
          feature: input.feature,
          ...intent,
          expectedStateDigest: state.stateDigest
        })
        if (!prepared.ok || event.action === "preflight") return prepared
        if (event.action !== "advance") throw Error("AUTOBIZ_MOD_ACTION_INVALID")
        if (intent.to === "design_done") {
          if (!/^[0-9a-f]{64}$/.test(prepared.stageChecksDigest))
            throw Error("AUTOBIZ_MOD_DESIGN_CHECK_DIGEST_REQUIRED")
          const confirmed = await $.ui.ask(
            "请确认技术设计产物无误后推进。Feature: " +
              input.feature +
              "；目标: " +
              intent.to +
              "；原状态摘要: " +
              state.stateDigest +
              "；原产物校验摘要: " +
              prepared.stageChecksDigest,
            { header: "技术设计确认", options: ["确认技术设计并推进", "取消"] }
          )
          if (confirmed !== "确认技术设计并推进")
            return {
              apiVersion,
              ok: false,
              status: "not-applied",
              errors: ["用户未确认技术设计，状态未推进。"]
            }
        }
        // Original validators and exact bytes are checked again inside both file locks.
        return invoke("advance", {
          feature: input.feature,
          ...intent,
          expectedStateDigest: input.expectedStateDigest,
          requestKey: input.requestKey,
          ...(intent.to === "design_done"
            ? { expectedChecksDigest: prepared.stageChecksDigest }
            : {})
        })
      }
    }
  )

  on("tool.call", async ($, event, next) => {
    const operation =
      event.tool === stateTool($.plugin.name, "read")
        ? "read"
        : event.tool === stateTool($.plugin.name, "preflight")
          ? "preflight"
          : event.tool === stateTool($.plugin.name, "advance")
            ? "advance"
            : event.tool === stateTool($.plugin.name, "reconcile")
              ? "reconcile"
              : undefined
    if (!operation) {
      if (ownLegacyWriterCall(event, $.plugin.root))
        return {
          isError: true,
          result: {
            ok: false,
            error: "AUTOBIZ_MOD_LEGACY_WRITER_BLOCKED",
            nextAction:
              "使用当前插件 state_read → state_preflight → state_advance。状态 Mod 调用原产物、Hooks 与 writer 校验，不要直接运行旧状态写入脚本。"
          }
        }
      return next(event)
    }
    const input = { ...event }
    delete input.tool
    delete input.tool_use_id
    delete input.agentId
    const receipt = await $.platform.act({
      ref: { provider: $.plugin.name, id: capabilityId, version: capabilityVersion },
      target: { kind: "current" },
      action: operation,
      input,
      requestKey: "state-transport:" + (await $.clock.now()) + ":" + ++sequence
    })
    const value = actionValue(receipt)
    return value.ok === true ? { result: value } : { isError: true, result: value }
  })

  on("command.run", { command: "autobiz-state-read" }, async ($, event) => {
    const receipt = await $.platform.act({
      ref: { provider: $.plugin.name, id: capabilityId, version: capabilityVersion },
      target: { kind: "current" },
      action: "read",
      input: { feature: event.args.trim() },
      requestKey: "state-transport:" + (await $.clock.now()) + ":" + ++sequence
    })
    return { text: JSON.stringify(actionValue(receipt)) }
  })
  on("command.run", { command: "autobiz-state-check" }, async ($, event) => {
    const [feature, to] = event.args.trim().split(/\s+/)
    const receipt = await $.platform.act({
      ref: { provider: $.plugin.name, id: capabilityId, version: capabilityVersion },
      target: { kind: "current" },
      action: "preflight",
      input: { feature, to },
      requestKey: "state-transport:" + (await $.clock.now()) + ":" + ++sequence
    })
    return { text: JSON.stringify(actionValue(receipt)) }
  })
  on("command.run", { command: "autobiz-state-advance" }, async ($, event) => {
    const [feature, to, expectedStateDigest, requestKey] = event.args.trim().split(/\s+/)
    const receipt = await $.platform.act({
      ref: { provider: $.plugin.name, id: capabilityId, version: capabilityVersion },
      target: { kind: "current" },
      action: "advance",
      input: { feature, to, expectedStateDigest, requestKey },
      requestKey: "state-transport:" + (await $.clock.now()) + ":" + ++sequence
    })
    return { text: JSON.stringify(actionValue(receipt)) }
  })
  on("command.run", { command: "autobiz-state-reconcile" }, async ($, event) => {
    const [feature, requestKey] = event.args.trim().split(/\s+/)
    const receipt = await $.platform.act({
      ref: { provider: $.plugin.name, id: capabilityId, version: capabilityVersion },
      target: { kind: "current" },
      action: "reconcile",
      input: { feature, requestKey },
      requestKey: "state-transport:" + (await $.clock.now()) + ":" + ++sequence
    })
    return { text: JSON.stringify(actionValue(receipt)) }
  })
}
