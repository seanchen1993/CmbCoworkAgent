import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import {
  assertGenericProjectArtifacts,
  assertGenericProjectReplacement,
  assertGenericProjectRepair,
  genericProjectCreatorScenario,
  readGenericProjectCandidate,
  type GenericProjectCandidate
} from "../support/generic-project-creator-scenario"

function candidate(revised = false): GenericProjectCandidate {
  const module = (id: string) => ({ id, version: "1.0.0", title: id,
    skill: `modules/${id}/SKILL.md`, inputs: [],
    outputs: [{ id: id === "trace-review" ? "review" : id,
      path: id === "trace-review" ? "review.json" : `${id}.json`, contract: "docs/v1" }],
    checks: [{ id: `${id}-schema`, kind: "json-schema" as const,
      artifactId: id === "trace-review" ? "review" : id,
      schema: revised && id === "trace-review" ? { required: ["evidence"] } : {} }],
    approval: "none" as const, resultApproval: "human" as const })
  return { digest: revised ? "b".repeat(64) : "a".repeat(64), revision: revised ? 2 : 1,
    draftId: "source-documents", directory: "unused",
    source: { apiVersion: "devclaw.native-composition/v1", plugin: {
      id: "source-documents", version: "1.0.0", title: "Documents", description: "Documents"
    }, resources: [], environment: [],
    modules: [module("collect"), module(revised ? "trace-review" : "review"), module("deliver")] },
    skills: { collect: "collect skill", [revised ? "trace-review" : "review"]:
      revised ? "trace references" : "review quality", deliver: "deliver skill" } }
}

function outputs() {
  const materials = { sources: [{ id: "source-a", title: "A", text: "first original quote" },
    { id: "source-b", title: "B", text: "second original quote" }] }
  const review = { sourceIds: ["source-a", "source-b"], summary: "current review", findings: ["gap"],
    evidence: [{ sourceId: "source-a", quote: "first original", assessment: "A" },
      { sourceId: "source-b", quote: "second original", assessment: "B" }] }
  return { materials, review,
    report: { sourceIds: ["source-a", "source-b"], reviewSummary: "current review", report: "report" } }
}

describe("generic project creator conversation acceptance", () => {
  it("keeps the same source identity when native trial progress is later attached", () => {
    const root = mkdtempSync(join(tmpdir(), "generic-project-source-read-"))
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    try {
      const value = candidate()
      const directory = join(root, "electron/mods/project-authoring", "scope",
        `${value.draftId}-r1-immutable`)
      mkdirSync(join(directory, "composition"), { recursive: true })
      writeFileSync(join(directory, "composition/source.json"), JSON.stringify(value.source))
      for (const module of value.source.modules) {
        const file = join(directory, module.skill)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, value.skills[module.id])
      }
      const request = { draftId: value.draftId, revision: 1, digest: value.digest }
      const original = readGenericProjectCandidate(root, request)
      const completed = { ...request, journey: { phase: "passed", canDeliver: true } }
      expect(readGenericProjectCandidate(root, completed)).toEqual(original)
      expect(Object.keys(original)).not.toContain("journey")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it("uses an independent three-stage request and a distinct replacement turn", () => {
    expect(genericProjectCreatorScenario.firstPrompt).toContain("native-modular")
    expect(genericProjectCreatorScenario.followupPrompt).toContain("trace-review")
    expect(Object.values(genericProjectCreatorScenario).join(" ")).not.toMatch(/autobiz|board_core/i)
  })
  it("accepts a new revision that changes only the middle module and skill", () => {
    expect(assertGenericProjectReplacement(candidate(), candidate(true)).stages)
      .toEqual(["collect", "trace-review", "deliver"])
  })
  it.each(["digest", "revision", "draftId"] as const)("rejects stale or unrelated %s", (key) => {
    const before = candidate()
    const after = candidate(true)
    if (key === "draftId") after.draftId = "another"
    else if (key === "digest") after.digest = before.digest
    else after.revision = before.revision
    expect(() => assertGenericProjectReplacement(before, after)).toThrow()
  })
  it("rejects accidental rewrites of surrounding skills", () => {
    const after = candidate(true)
    after.skills.deliver += "changed"
    expect(() => assertGenericProjectReplacement(candidate(), after)).toThrow(/OTHER_SKILL_CHANGED/)
  })
  it("allows conversational repair of deliver only, preserving the composed contract", () => {
    const before = candidate(true)
    const after = structuredClone(before)
    after.revision++
    after.digest = "c".repeat(64)
    after.skills.deliver += " Copy current review summary verbatim."
    expect(assertGenericProjectRepair(before, after).after.revision).toBe(3)
    after.source.modules[1].outputs[0].path = "changed.json"
    expect(() => assertGenericProjectRepair(before, after)).toThrow(/CONTRACT_CHANGED/)
  })
  it("rejects disconnected output contracts", () => {
    const after = candidate(true)
    after.source.modules[1].outputs[0].path = "another.json"
    expect(() => assertGenericProjectReplacement(candidate(), after)).toThrow(/HANDOFF_CHANGED/)
  })
  it("accepts matching current sources, evidence and review handoff", () => {
    const { materials, review, report } = outputs()
    expect(assertGenericProjectArtifacts(materials, review, report).citations).toBe(2)
  })
  it("rejects a plausible quote fabricated outside the current sources", () => {
    const { materials, review, report } = outputs()
    review.evidence[0].quote = "invented quotation"
    expect(() => assertGenericProjectArtifacts(materials, review, report)).toThrow(/QUOTED|QUOTATION/)
  })
  it("allows extra exact title evidence only alongside real content citations", () => {
    const { materials, review, report } = outputs()
    review.evidence.push({ sourceId: "source-a", quote: "A", assessment: "title checked" })
    expect(assertGenericProjectArtifacts(materials, review, report).citations).toBe(3)
  })
  it("rejects extra fabricated evidence even when valid content citations are present", () => {
    const { materials, review, report } = outputs()
    review.evidence.push({ sourceId: "source-a", quote: "fabricated fact", assessment: "unfounded" })
    expect(() => assertGenericProjectArtifacts(materials, review, report)).toThrow(/QUOTATION/)
  })
  it("rejects replacing all content evidence with title-only citations", () => {
    const { materials, review, report } = outputs()
    review.evidence = [{ sourceId: "source-a", quote: "A", assessment: "title checked" },
      { sourceId: "source-b", quote: "B", assessment: "title checked" }]
    expect(() => assertGenericProjectArtifacts(materials, review, report)).toThrow(/CONTENT_NOT_QUOTED/)
  })
  it("rejects a report copied from an older review", () => {
    const { materials, review, report } = outputs()
    report.reviewSummary = "previous review"
    expect(() => assertGenericProjectArtifacts(materials, review, report)).toThrow(/OLD_REVIEW/)
  })
  it("rejects a missing source even if the review claims successful completion", () => {
    const { materials, review, report } = outputs()
    review.sourceIds.pop()
    expect(() => assertGenericProjectArtifacts(materials, review, report)).toThrow(/SOURCES_CHANGED/)
  })
})
