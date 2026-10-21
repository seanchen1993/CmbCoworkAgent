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

export function register(on) {
  let sequence = 0
  on("session.start", async ($, event, next) => {
    await $.command.register({
      name: "autobiz-state-read",
      description: "读取真实 AutoBiz 状态；不修复、不推进"
    })
    await $.command.register({
      name: "autobiz-state-check",
      description: "检查 Mod 固定图和原 Hooks；不推进"
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
            return {
              apiVersion,
              ok: value.ok,
              status: value.status,
              feature: value.feature,
              record: value.record,
              stateDigest: value.stateDigest,
              markdownDigest: value.markdownDigest
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
            requestKey: input.requestKey
          })
        const intent = decide(state.record, input.to)
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
    if (!operation) return next(event)
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
