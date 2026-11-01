import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import { compileNativeComposition } from "../../plugins/native-composition"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { createAuthoringSourceBundle, AUTHORING_BUNDLE_LIMITS } from "./authoring-bundle"
import { testProjectSource } from "./project-contract"
import { readProjectSource } from "./project-source"
import {
  assertProjectPackageReportUnchanged,
  createProjectPackageReport,
  parseProjectPackageReport,
  projectPackageActualExcluded,
  PROJECT_PACKAGE_REPORT_PATH,
  readProjectPackageReport
} from "./project-package-report"

const cleanup: string[] = []
interface MutableReport {
  schemaVersion: unknown
  hooks?: unknown
  packageId: string
  version: string
  sourceDigest: string
  files: string[]
  excluded: string[]
  dependencies: unknown[]
  tests: {
    digest: string
    valid: boolean
    cases: Array<{
      stageId: string
      expected: "passed" | "failed"
      actual: "passed" | "failed"
    }>
  }
}
afterEach(async () => {
  for (const root of cleanup.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("project-report-test-")
    )
      throw Error("Unsafe report test cleanup")
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "project-report-test-"))
  cleanup.push(root)
  const original = await readProjectSource(resolve("tests/fixtures/native-compositions/vendor"))
  const declaration = JSON.parse(
    original.bundle.files.find((file) => file.path === "composition/source.json")!.text
  )
  const compiled = compileNativeComposition(declaration, {
    files: original.bundle.files.map((file) => ({
      path: file.path,
      bytes: Buffer.from(file.text)
    })),
    actionCatalog: []
  })
  const bundle = createAuthoringSourceBundle(
    compiled.files.map((file) => ({ path: file.path, text: file.bytes.toString("utf8") }))
  )
  const manifest = parseProjectRuntimeManifest(
    JSON.parse(bundle.files.find((file) => file.path === "devclaw.project-runtime.json")!.text)
  )
  const tests = await testProjectSource(bundle, manifest)
  expect(tests.valid).toBe(true)
  const report = createProjectPackageReport(bundle, manifest, [], tests)
  return { root, bundle, manifest, tests, report, file: join(root, PROJECT_PACKAGE_REPORT_PATH) }
}

describe("shared non-executing package report v1", () => {
  it("compares complete native action identities from the actual runtime manifest", async () => {
    const f = await fixture()
    const sourceManifest = structuredClone(f.manifest)
    sourceManifest.actions = [
      {
        id: "external-check",
        ref: {
          pluginId: "provider-install",
          plugin: "shared-provider",
          digest: "a".repeat(64),
          actionId: "check"
        }
      }
    ]
    const bundle = createAuthoringSourceBundle(
      f.bundle.files.map((file) =>
        file.path === "devclaw.project-runtime.json"
          ? { ...file, text: JSON.stringify(sourceManifest) }
          : file
      )
    )
    const manifest = parseProjectRuntimeManifest(
      JSON.parse(bundle.files.find((file) => file.path === "devclaw.project-runtime.json")!.text)
    )
    const tests = await testProjectSource(bundle, manifest)
    const report = createProjectPackageReport(bundle, manifest, [], tests)
    expect(report.dependencies).toEqual(manifest.actions.map((action) => action.ref))
    expect(parseProjectPackageReport(JSON.stringify(report), bundle)).toEqual(report)
    report.dependencies[0].digest = "b".repeat(64)
    expect(() => parseProjectPackageReport(JSON.stringify(report), bundle)).toThrow(
      "PROJECT_PACKAGE_REPORT_INVALID"
    )
  })
  it("uses the producer's exact author domain and keeps historical exclusions informational", async () => {
    const f = await fixture()
    const report = createProjectPackageReport(f.bundle, f.manifest, ["old-source.log"], f.tests)
    expect(parseProjectPackageReport(JSON.stringify(report), f.bundle)).toEqual(report)
    expect(report.files).not.toContain(PROJECT_PACKAGE_REPORT_PATH)
    await writeFile(f.file, JSON.stringify(report))
    const observed = readProjectPackageReport(f.root, f.bundle)!
    expect(observed.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(
      projectPackageActualExcluded([PROJECT_PACKAGE_REPORT_PATH, "old-source.log"], observed)
    ).toEqual(["old-source.log"])
    expect(projectPackageActualExcluded([PROJECT_PACKAGE_REPORT_PATH])).toEqual([
      PROJECT_PACKAGE_REPORT_PATH
    ])
  })

  it.each([
    [
      "schema",
      (r: MutableReport) => {
        r.schemaVersion = 2
      }
    ],
    [
      "unknown registration",
      (r: MutableReport) => {
        r.hooks = "extra.js"
      }
    ],
    [
      "package",
      (r: MutableReport) => {
        r.packageId = "other"
      }
    ],
    [
      "version",
      (r: MutableReport) => {
        r.version = "9.9.9"
      }
    ],
    [
      "source digest",
      (r: MutableReport) => {
        r.sourceDigest = "0".repeat(64)
      }
    ],
    [
      "test digest",
      (r: MutableReport) => {
        r.tests.digest = "0".repeat(64)
      }
    ],
    [
      "test validity",
      (r: MutableReport) => {
        r.tests.valid = false
      }
    ],
    [
      "test case",
      (r: MutableReport) => {
        r.tests.cases[0].stageId = "other"
      }
    ],
    [
      "false result",
      (r: MutableReport) => {
        r.tests.cases[0].actual = r.tests.cases[0].expected === "passed" ? "failed" : "passed"
      }
    ],
    [
      "dependencies",
      (r: MutableReport) => {
        r.dependencies.push("undeclared.action")
      }
    ],
    [
      "missing file",
      (r: MutableReport) => {
        r.files.pop()
      }
    ],
    [
      "extra file",
      (r: MutableReport) => {
        r.files.push("extra.md")
      }
    ],
    [
      "duplicate file",
      (r: MutableReport) => {
        r.files.push(r.files[0])
      }
    ],
    [
      "case duplicate",
      (r: MutableReport) => {
        r.files.push(r.files[0].toUpperCase())
      }
    ],
    [
      "self reference",
      (r: MutableReport) => {
        r.files.push(PROJECT_PACKAGE_REPORT_PATH)
      }
    ],
    [
      "excluded self",
      (r: MutableReport) => {
        r.excluded.push(PROJECT_PACKAGE_REPORT_PATH)
      }
    ],
    [
      "excluded retained",
      (r: MutableReport) => {
        r.excluded.push(r.files[0])
      }
    ],
    [
      "excluded outside",
      (r: MutableReport) => {
        r.excluded.push("../other")
      }
    ],
    [
      "excluded absolute",
      (r: MutableReport) => {
        r.excluded.push("C:/other")
      }
    ],
    [
      "excluded duplicate",
      (r: MutableReport) => {
        r.excluded.push("old.log", "old.log")
      }
    ]
  ])("rejects inconsistent %s instead of trusting historical checks", async (_name, mutate) => {
    const f = await fixture()
    const report = structuredClone(f.report)
    mutate(report)
    expect(() => parseProjectPackageReport(JSON.stringify(report), f.bundle)).toThrow(
      "PROJECT_PACKAGE_REPORT_INVALID"
    )
  })

  it("rejects changed source, invalid JSON/UTF8, oversized reports and file links", async () => {
    const f = await fixture()
    const changed = createAuthoringSourceBundle(
      f.bundle.files.map((file) =>
        file.path.endsWith("SKILL.md") ? { ...file, text: file.text + "\n" } : file
      )
    )
    expect(() => parseProjectPackageReport(JSON.stringify(f.report), changed)).toThrow(
      "PROJECT_PACKAGE_REPORT_INVALID"
    )
    expect(() => parseProjectPackageReport("{broken", f.bundle)).toThrow(
      "PROJECT_PACKAGE_REPORT_INVALID"
    )
    await writeFile(f.file, Buffer.from([0xc3]))
    expect(() => readProjectPackageReport(f.root, f.bundle)).toThrow("AUTHORING_VERSION_CHANGED")
    await writeFile(f.file, " ".repeat(AUTHORING_BUNDLE_LIMITS.fileBytes + 1))
    expect(() => readProjectPackageReport(f.root, f.bundle)).toThrow("AUTHORING_VERSION_CHANGED")
    await writeFile(f.file, JSON.stringify(f.report))
    await link(f.file, join(f.root, "second.json"))
    expect(() => readProjectPackageReport(f.root, f.bundle)).toThrow("AUTHORING_VERSION_CHANGED")
  })

  it("fences byte or identity changes even when the report JSON remains equivalent", async () => {
    const f = await fixture()
    await writeFile(f.file, JSON.stringify(f.report))
    const observed = readProjectPackageReport(f.root, f.bundle)!
    await writeFile(f.file, JSON.stringify(f.report) + "\n")
    expect(() => assertProjectPackageReportUnchanged(f.root, observed)).toThrow(
      "AUTHORING_VERSION_CHANGED"
    )
    expect(readProjectPackageReport(f.root, f.bundle)?.sha256).not.toBe(observed.sha256)
    await mkdir(join(f.root, "other"))
    expect(() => assertProjectPackageReportUnchanged(f.root, observed)).toThrow(
      "AUTHORING_VERSION_CHANGED"
    )
  })
})
