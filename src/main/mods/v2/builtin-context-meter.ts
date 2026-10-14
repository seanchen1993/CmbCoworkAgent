import { createHash } from "node:crypto"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"

export const CONTEXT_METER_NAME = "cmb-context-meter"
export const CONTEXT_METER_CAPABILITIES = ["session.usage", "ui.resolve", "ui.invalidate"]

/** Fixed application code. No uploaded manifest can provide or configure this module. */
export const CONTEXT_METER_CODE = `var __cmbFunctionMod = {
  register(on) {
    on("ui.render", { component: "AbovePrompt" }, async ($, event, next) => {
      if (event.props.hasSurvey) return next(event)
      const usage = await $.session.usage()
      const context = usage.context
      if (!context || !Number.isFinite(context.window) || context.window <= 0 ||
          !Number.isFinite(context.tokens) || context.tokens < 0) return next(event)
      const percent = Math.round(context.tokens / context.window * 1000) / 10
      const estimated = context.breakdown && context.breakdown.estimated === true
      const { Text } = $.ui.resolve(event)
      return Text({ children: "上下文" + (estimated ? "（估算）" : "") + "：" +
        context.tokens + " / " + context.window + " tokens · " + percent + "%" })
    })
    on("turn.complete", async ($, event, next) => {
      const result = await next(event)
      await $.ui.invalidate("ui.render")
      return result
    })
  }
}`

export function contextMeterStatus(): FunctionPluginStatus {
  return {
    pluginId: `builtin:${CONTEXT_METER_NAME}`,
    name: CONTEXT_METER_NAME,
    digest: createHash("sha256").update(CONTEXT_METER_CODE).digest("hex"),
    state: "ready",
    capabilities: [...CONTEXT_METER_CAPABILITIES]
  }
}
