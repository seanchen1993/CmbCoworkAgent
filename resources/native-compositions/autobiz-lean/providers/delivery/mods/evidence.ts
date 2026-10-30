import type { SDK } from "devclaw-mods"
import { readInputs } from "./inputs"
import { checkCodeResult } from "./code-result"

export function registerEvidence(on: any) {
  on.capability({
    apiVersion: "devclaw.capability/v1", id: "delivery-evidence", version: "1.0.0",
    title: "四阶段真实执行证据", scope: "conversation", stateSchema: { type: "object" },
    actions: [
  {
    "id": "code.verify",
    "title": "code.verify",
    "inputSchema": {
      "type": "object"
    },
    "outputSchema": {
      "type": "object"
    },
    "requiredPermissions": [
      "process.run",
      "platform.read",
      "platform.act"
    ],
    "cancellable": true,
    "idempotency": "keyed"
  },
  {
    "id": "delivery.verify",
    "title": "delivery.verify",
    "inputSchema": {
      "type": "object"
    },
    "outputSchema": {
      "type": "object"
    },
    "requiredPermissions": [
      "process.run",
      "platform.read",
      "platform.act"
    ],
    "cancellable": true,
    "idempotency": "keyed"
  }
]
  }, {
    act: async ($: Pick<SDK, "process" | "platform">, event: any) => {
      const envelope = event.input
      const reference = envelope?.input
      const stage = event.action === "code.verify" ? "code" : "delivery"
      if (envelope?.version !== 1 || reference?.stageId !== stage ||
          !["code.verify", "delivery.verify"].includes(event.action))
        throw Error("LEAN_HOST_REFERENCE_REQUIRED")
      const inputs = await readInputs($, reference, event.action, envelope.config?.artifactRoles)
      const selection = inputs.documents["Code.json"]
      if (!selection || Object.keys(selection).sort().join("|") !== "feature|runId")
        throw Error("LEAN_CODE_SELECTION_INVALID")
      // Business policy belongs to the locked rules provider. Host requires its independent
      // mandatory check too; this checker verifies only consumed structure and original evidence.
      if (stage === "delivery") {
        const delivered = inputs.documents["Delivery.json"]
        if (!delivered || delivered.feature !== selection.feature ||
            delivered.codeRunId !== selection.runId ||
            delivered.publication?.mode !== "not-requested" ||
            delivered.publication?.status !== "prepared-only")
          throw Error("LEAN_DELIVERY_IDENTITY_INVALID")
        const names = ["RequestBaseline.json", "Definition.json", "Solution.json", "Code.json"]
        if (!delivered.archive || Object.keys(delivered.archive).length !== names.length ||
            names.some((name: any) => delivered.archive[inputs.paths[name]]?.text !== inputs.texts[name] ||
              delivered.archive[inputs.paths[name]]?.sha256 !== inputs.inputDigests[inputs.paths[name]]))
          throw Error("LEAN_ARCHIVE_SOURCE_CHANGED")
      }
      const checked = await checkCodeResult($, { ...envelope, input: selection }, { ...inputs, executionAdapter: reference.configuration?.executionAdapter })
      // Close the action's input race after all paged original evidence was read.
      const after = await readInputs($, reference, event.action, envelope.config?.artifactRoles)
      if (JSON.stringify(after.inputDigests) !== JSON.stringify(inputs.inputDigests))
        throw Error("LEAN_CODE_INPUT_CHANGED")
      return { status: "succeeded", text: "原始输入、真实测试统计与Git合并回执已核对", output: {
        ...checked, inputSha256: reference.current.sha256, inputDigests: inputs.inputDigests,
        publication: stage === "delivery" ? "prepared-only" : null
      } }
    }
  })
}
