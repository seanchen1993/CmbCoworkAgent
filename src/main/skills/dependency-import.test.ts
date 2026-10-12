import { expect, it } from "vitest"
import { inspectSkillImport } from "./import-preview"

it("previews structured dependencies without running probes or treating metadata as verification", () => {
  const preview = inspectSkillImport(
    Buffer.from(
      `---\nname: dependency-fixture\ncmbdevclaw-dependencies:\n  schemaVersion: 1\n  checks:\n    - {id: node, kind: executable, name: node, minimumVersion: 22.16.0}\n---\nSteps.`
    ),
    "SKILL.md"
  )
  expect(preview.dependencies).toMatchObject({
    source: "cmbdevclaw",
    state: "structured",
    checks: [{ id: "node", kind: "executable", name: "node", minimumVersion: "22.16.0" }]
  })
  expect(preview).not.toHaveProperty("verified")
})
it("keeps original free compatibility text distinct from structured requirements", () => {
  const preview = inspectSkillImport(
    Buffer.from(
      "---\nname: dependency-fixture\ncompatibility: Requires Git and a login\n---\nSteps."
    ),
    "SKILL.md"
  )
  expect(preview.compatibility).toBe("Requires Git and a login")
  expect(preview.dependencies).toMatchObject({ state: "unstructured", checks: [] })
})
