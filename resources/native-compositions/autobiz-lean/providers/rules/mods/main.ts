import { rules } from "./rules-bundle"
import { program } from "./check-program"

const actions = [
  "baseline.verify",
  "definition.verify",
  "solution.verify",
  "solution.inspect",
  "delivery.documents"
]
export function register(on) {
  on.capability(
    {
      apiVersion: "devclaw.capability/v1",
      id: "business",
      version: "1.0.0",
      title: "AutoBiz需求基线与业务规则",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: actions.map((id) => ({
        id,
        title: id,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        requiredPermissions: ["process.run"],
        cancellable: true,
        idempotency: "keyed"
      }))
    },
    {
      act: async ($, event) => {
        if (!actions.includes(event.action)) throw Error("LEAN_BUSINESS_ACTION_UNKNOWN")
        const result = await $.process.run(["python", "-I", "-B", "-X", "utf8", "-c", program], {
          stdin: JSON.stringify({
            action: event.action,
            reference: event.input.input,
            config: event.input.config ?? {},
            rules
          }),
          timeoutMs: 30000
        })
        const output = JSON.parse(result.stdout)
        if (
          typeof output?.passed !== "boolean" ||
          !Array.isArray(output.errors) ||
          !Array.isArray(output.warnings) ||
          !Number.isInteger(result.exitCode) ||
          result.exitCode < 0 ||
          (result.exitCode === 0) !== output.passed
        )
          throw Error("LEAN_BUSINESS_REPORT_INVALID")
        return {
          status: output.passed ? "succeeded" : "failed",
          text: "实际产物业务规则验收",
          output
        }
      }
    }
  )
}
