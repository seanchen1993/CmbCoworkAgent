import { createHash } from "node:crypto"

export function baselineFixture(feature: string, requirements: string[], projectId = "orders") {
  const text = requirements.join("\n")
  return {
    feature,
    request: {
      protocol: "devclaw.project-goal/v1" as const,
      projectId,
      text,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex")
    },
    requirements: requirements.map((text, index) => ({
      id: "USR-" + String(index + 1).padStart(3, "0"),
      text,
      sourceQuote: text
    })),
    decisions: [] as Array<{ id: string; text: string; requirementIds: string[] }>
  }
}

export function baselineDefinitionFields(
  baseline: ReturnType<typeof baselineFixture>,
  specs: Record<string, string>
) {
  const refs = Object.entries(specs).flatMap(([capability, text]) =>
    [...text.matchAll(/^#{3,4} (?:Requirement|Scenario) ((?:REQ|SCN)-\d{3}):/gm)].map(
      (match) => `specs/${capability}/spec.md#${match[1]}`
    )
  )
  return {
    baselineSha256: createHash("sha256").update(JSON.stringify(baseline)).digest("hex"),
    requirementIds: baseline.requirements.map((item) => item.id),
    requirementCoverage: Object.fromEntries(baseline.requirements.map((item) => [item.id, refs])),
    baselineDecisions: structuredClone(baseline.decisions),
    decisionCoverage: Object.fromEntries(baseline.decisions.map((item) => [item.id, [...refs]]))
  }
}
