import { inspectVerifiedArtifacts } from "./inspect"

export function register(on) {
  on("session.start", async ($, event, next) => {
    await $.tool.register({ name: "inspect", isDeferred: false,
      description: "Verify bound producer JSON artifacts and return the actual parsed content",
      inputSchema: { type: "object", required: ["requiredIds"], additionalProperties: false,
        properties: { requiredIds: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } } } }
    })
    return next(event)
  })
  on("tool.call", { tool: "mcp__verified-artifact-consumer__inspect" }, async ($, event) => {
    // Fixed original composition input. A model cannot substitute an invented bundle argument.
    const report = inspectVerifiedArtifacts(await $.fs.read("inputs/verified-context.json"), event.requiredIds)
    const content = JSON.stringify(report, null, 2) + "\n"
    if (await $.fs.exists("consumed-report.json")) {
      if (await $.fs.read("consumed-report.json") !== content) throw Error("VERIFIED_REPORT_CONFLICT")
    } else await $.fs.write("consumed-report.json", content)
    return { result: report }
  })
  on.capability({
    apiVersion: "devclaw.capability/v1", id: "verified-artifacts", version: "1.0.0",
    title: "已校验 JSON 产物消费", scope: "conversation", stateSchema: { type: "object" },
    actions: [{ id: "inspect", title: "核对并转换", inputSchema: { type: "object" },
      outputSchema: { type: "object" }, requiredPermissions: [], cancellable: true,
      idempotency: "keyed" }]
  }, {
    act: async (_$, event) => {
      const input = event.input.input
      const report = inspectVerifiedArtifacts(input.content, input.requiredIds)
      return { status: "succeeded", text: "已核对并消费 " + report.artifacts.length + " 个 JSON 产物；业务认可仍以生产者规则为准。", output: report }
    }
  })
}
