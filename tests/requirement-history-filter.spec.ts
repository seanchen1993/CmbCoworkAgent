import assert from "node:assert/strict"
import type { RequirementRecord } from "../src/renderer/src/components/requirement/requirement-data"
import { filterRequirementsBySystem } from "../src/renderer/src/components/requirement/requirement-history-filter"

const requirements: RequirementRecord[] = [
  {
    id: "req-001",
    threadId: "thread-001",
    systemId: "brand-tesla",
    title: "Tesla checkout refresh",
    updatedAt: "2026-08-26 10:00:00",
    system: "Tesla",
    status: "沟通中",
    fileName: "checkout.docx",
    link: "",
    sourceType: "file",
    sourceName: "checkout.docx",
    workDir: "/tmp",
    requirementPath: "/tmp/requirements/req-001",
    workspacePath: "/tmp/req-001",
    sourcePath: "/tmp/req-001/source/checkout.docx",
    sourcePreview: "# Checkout",
    prdPath: "/tmp/req-001/prd/manifest.json",
    prdGenerated: false,
    prdPreviewPath: null,
    prdPreviewFileName: null,
    prdPreview: "",
    prd: "否",
    prdVersion: null,
    featureCount: 0,
    modules: []
  },
  {
    id: "req-002",
    threadId: "thread-002",
    systemId: "brand-vercel",
    title: "Vercel dashboard refresh",
    updatedAt: "2026-08-26 10:00:00",
    system: "Vercel",
    status: "已生成 v1",
    fileName: "dashboard.docx",
    link: "",
    sourceType: "file",
    sourceName: "dashboard.docx",
    workDir: "/tmp",
    requirementPath: "/tmp/requirements/req-002",
    workspacePath: "/tmp/req-002",
    sourcePath: "/tmp/req-002/source/dashboard.docx",
    sourcePreview: "# Dashboard",
    prdPath: "/tmp/req-002/prd/manifest.json",
    prdGenerated: true,
    prdPreviewPath: "/tmp/req-002/prd/PRD.md",
    prdPreviewFileName: "PRD.md",
    prdPreview: "# Dashboard PRD",
    prd: "是",
    prdVersion: "v1",
    featureCount: 1,
    modules: [{ moduleId: "mod-001", name: "Dashboard", filePath: "modules/mod-001.md" }]
  }
]

const allRequirements = filterRequirementsBySystem(requirements, null)
assert.equal(
  allRequirements.length,
  requirements.length,
  "all systems should show every requirement"
)

const teslaRequirements = filterRequirementsBySystem(requirements, "brand-tesla")
assert.equal(
  teslaRequirements.length,
  1,
  "selected design system should show matching requirements"
)
assert.ok(teslaRequirements.every((item) => item.systemId === "brand-tesla"))

const unknownSystemRequirements = filterRequirementsBySystem(requirements, "unknown-system")
assert.equal(
  unknownSystemRequirements.length,
  0,
  "unknown design systems should not match requirements"
)

console.log("requirement-history-filter: all assertions passed")
