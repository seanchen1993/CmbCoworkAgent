import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import { assertStageBranchSourceCompatible } from "./stage-branch-compatibility"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const declaration = [
  "---",
  "name: review",
  "description: Native review stage",
  "model: inherited",
  "allowed-tools:",
  "  - read_file",
  "metadata:",
  "  domain: documents",
  "---",
  ""
].join("\n")

function fixture(shared = false, skill = `${declaration}Original body\n`) {
  const root = mkdtempSync(join(tmpdir(), "stage-source-compatibility-"))
  roots.push(root)
  const original = join(root, "original")
  const candidate = join(root, "candidate")
  mkdirSync(original)
  const raw = hostProjectFixture(join(root, "workspace")).manifest
  if (shared) raw.stages[1].skill = raw.stages[0].skill
  const manifest = parseProjectRuntimeManifest(raw)
  for (const stage of manifest.stages) {
    const path = join(original, stage.skill!)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, stage.id === "review" || shared ? skill : "---\nname: draft\n---\nDraft\n")
  }
  writeFileSync(join(original, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  mkdirSync(join(original, "knowledge"))
  writeFileSync(join(original, "knowledge", "policy.md"), "Original upstream knowledge\n")
  cpSync(original, candidate, { recursive: true })
  return {
    original,
    candidate,
    edit: (text: string) => writeFileSync(join(candidate, manifest.stages[1].skill!), text),
    check: () => assertStageBranchSourceCompatible(original, candidate, manifest, manifest, "review")
  }
}

describe("stage branch Skill declaration compatibility", () => {
  it("allows only a revised body with the exact original declaration", () => {
    const setup = fixture()
    setup.edit(`${declaration}Improved review instructions\n\n---\nA body separator\n`)
    expect(setup.check).not.toThrow()
  })

  it.each([
    ["name", "name: review", "name: replacement"],
    ["model", "model: inherited", "model: different-model"],
    ["tools", "  - read_file", "  - write_file"],
    ["metadata", "  domain: documents", "  domain: deployment"],
    ["description", "description: Native review stage", "description: Different behavior"]
  ])("rejects changed %s frontmatter", (_field, before, after) => {
    const setup = fixture()
    setup.edit(`${declaration.replace(before, after)}Improved body\n`)
    expect(setup.check).toThrow("PROJECT_HOST_BRANCH_INPUT_SOURCE_CHANGED")
  })

  it.each([
    "---\nname: [unterminated\n---\nBody\n",
    "---\nname: review\nname: replacement\n---\nBody\n",
    "---\nmetadata:\n  domain: first\n  domain: second\n---\nBody\n",
    "---\n- not-a-map\n---\nBody\n",
    "---\nname: review\nMissing delimiter\n"
  ])("rejects malformed or duplicate YAML instead of the runtime fallback: %s", (text) => {
    const setup = fixture()
    setup.edit(text)
    expect(setup.check).toThrow("PROJECT_HOST_BRANCH_SKILL_DECLARATION_INVALID")
  })

  it("also rejects invalid original frontmatter even if the candidate repeats it", () => {
    const setup = fixture(false, "---\nname: review\nname: duplicate\n---\nBody\n")
    expect(setup.check).toThrow("PROJECT_HOST_BRANCH_SKILL_DECLARATION_INVALID")
  })

  it("rejects adding or removing a declaration", () => {
    const setup = fixture()
    setup.edit("Only a new body\n")
    expect(setup.check).toThrow("PROJECT_HOST_BRANCH_INPUT_SOURCE_CHANGED")
    const without = fixture(false, "Original body without frontmatter\n")
    without.edit(`${declaration}New body\n`)
    expect(without.check).toThrow("PROJECT_HOST_BRANCH_INPUT_SOURCE_CHANGED")
  })

  it("keeps declaration-free Skill body edits possible", () => {
    const setup = fixture(false, "Original body without frontmatter\n")
    setup.edit("Revised body without frontmatter\n")
    expect(setup.check).not.toThrow()
  })

  it("rejects changing a Skill shared with an earlier stage, including just its body", () => {
    const setup = fixture(true)
    setup.edit(`${declaration}Revised shared instructions\n`)
    expect(setup.check).toThrow("PROJECT_HOST_BRANCH_INPUT_SOURCE_CHANGED")
  })

  it("keeps upstream knowledge immutable", () => {
    const setup = fixture()
    writeFileSync(join(setup.candidate, "knowledge", "policy.md"), "Changed upstream knowledge\n")
    expect(setup.check).toThrow("PROJECT_HOST_BRANCH_INPUT_SOURCE_CHANGED")
  })
})
