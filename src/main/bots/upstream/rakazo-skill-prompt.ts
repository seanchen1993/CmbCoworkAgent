// Extracted from Rakazo, Apache-2.0. See RAKAZO-LICENSE and PROVENANCE.json.
export type SkillPlaybook = {
  whenToUse: string
  inputs: string[]
  steps: string[]
  howToCheck: string
  whatToReturn: string
  approvalBoundaries: string
  failureHandling: string
}

export function formatSkillRunPrompt(name: string, playbook: SkillPlaybook, test = false): string {
  const safety = test
    ? "This is a safe test run. Do not send, spend, delete, or publish anything."
    : ""
  return [
    `Run taught skill: ${name}`,
    safety,
    `When to use: ${playbook.whenToUse}`,
    playbook.inputs.length ? `Inputs: ${playbook.inputs.join("; ")}` : undefined,
    "Steps:",
    ...playbook.steps.map((step, index) => `${index + 1}. ${step}`),
    `How to check: ${playbook.howToCheck}`,
    `Return: ${playbook.whatToReturn}`,
    `Approval boundaries: ${playbook.approvalBoundaries}`,
    `Failure handling: ${playbook.failureHandling}`
  ]
    .filter(Boolean)
    .join("\n")
}
