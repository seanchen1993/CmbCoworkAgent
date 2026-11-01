import { createHash } from "node:crypto"
import { existsSync, lstatSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import {
  parseProjectRuntimeManifest,
  type ProjectRuntimeManifest
} from "../../../shared/project-runtime"
import { AUTHORING_BUNDLE_LIMITS, type AuthoringSourceBundle } from "./authoring-bundle"
import { readBoundedAuthoringVersionFile } from "./authoring-version-file"
import { projectContractCaseSummaries, type ProjectContractReport } from "./project-contract"

export const PROJECT_PACKAGE_REPORT_PATH = "devclaw.package-report.json"
const installHint = "通过原插件页面的 ZIP 安装入口；创建项目时由宿主绑定真实安装 UUID。"
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().max(AUTHORING_BUNDLE_LIMITS.pathLength)
const checkResult = z.enum(["passed", "failed"])
const caseResult = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    stageId: z.string().min(1).max(100),
    expected: checkResult,
    actual: checkResult,
    matched: z.literal(true)
  })
  .strict()
const actionIdentity = z
  .object({
    pluginId: z.string().min(1).max(256),
    plugin: z.string().regex(/^[a-zA-Z0-9][\w.-]{0,99}$/),
    digest,
    actionId: z.string().regex(/^[a-zA-Z0-9][\w.-]{0,79}$/)
  })
  .strict()
const schema = z
  .object({
    schemaVersion: z.literal(1),
    packageId: z.string().min(1).max(256),
    version: z.string().min(1).max(100),
    sourceDigest: digest,
    files: z.array(text).min(1).max(AUTHORING_BUNDLE_LIMITS.files),
    excluded: z.array(z.string().max(AUTHORING_BUNDLE_LIMITS.fileBytes)).max(128),
    dependencies: z.array(actionIdentity).max(128),
    tests: z
      .object({
        valid: z.literal(true),
        digest,
        scope: z.literal("isolated-host-artifact-checks"),
        cases: z.array(caseResult).min(1).max(32),
        limitations: z.array(z.string().max(2048)).max(32),
        diagnostics: z.array(z.never()).max(0).optional()
      })
      .strict(),
    install: z.literal(installHint)
  })
  .strict()
export type ProjectPackageReport = z.infer<typeof schema>
export interface ProjectPackageReportObservation {
  report: ProjectPackageReport
  sha256: string
  fileIdentity: string
  rootIdentity: string
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
function invalid(): never {
  throw Error("PROJECT_PACKAGE_REPORT_INVALID")
}
function identity(path: string, directory: boolean) {
  const stat = lstatSync(path, { bigint: true })
  if (
    stat.isSymbolicLink() ||
    (directory
      ? !stat.isDirectory() || realpathSync(path) !== resolve(path)
      : !stat.isFile() || stat.nlink !== 1n)
  )
    throw Error("AUTHORING_VERSION_CHANGED")
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(
    ":"
  )
}
function paths(values: string[]) {
  const seen = new Set<string>()
  for (const value of values) {
    if (
      !value ||
      /[\\<>:"|?*]/.test(value) ||
      [...value].some((character) => {
        const code = character.codePointAt(0)!
        return (
          code < 32 ||
          (code >= 127 && code <= 159) ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)
        )
      }) ||
      value
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /[. ]$/.test(part) ||
            /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
        ) ||
      seen.has(value.toLowerCase())
    )
      invalid()
    seen.add(value.toLowerCase())
  }
  return values
}
function manifestFor(bundle: AuthoringSourceBundle) {
  const file = bundle.files.find((file) => file.path === "devclaw.project-runtime.json")
  if (!file) invalid()
  return parseProjectRuntimeManifest(JSON.parse(file.text))
}

/** A report is historical non-executing metadata, never an approval or test authority. */
export function parseProjectPackageReport(
  raw: string,
  bundle: AuthoringSourceBundle,
  declaredManifest?: ProjectRuntimeManifest
): ProjectPackageReport {
  try {
    const manifest = declaredManifest ?? manifestFor(bundle)
    if (Buffer.byteLength(raw) > AUTHORING_BUNDLE_LIMITS.fileBytes) invalid()
    const report = schema.parse(JSON.parse(raw))
    const files = bundle.files.map((file) => file.path)
    const fileNames = new Set(files.map((path) => path.toLowerCase()))
    paths(report.files)
    paths(report.excluded)
    if (
      fileNames.has(PROJECT_PACKAGE_REPORT_PATH) ||
      report.files.some((path) => path.toLowerCase() === PROJECT_PACKAGE_REPORT_PATH) ||
      report.excluded.some((path) => path.toLowerCase() === PROJECT_PACKAGE_REPORT_PATH) ||
      report.excluded.some((path) => fileNames.has(path.toLowerCase())) ||
      report.packageId !== manifest.plugin.id ||
      report.version !== manifest.plugin.version ||
      report.sourceDigest !== bundle.digest ||
      report.tests.digest !== bundle.digest ||
      !isDeepStrictEqual(report.files, files) ||
      !isDeepStrictEqual(
        report.dependencies,
        manifest.actions.map((action) => action.ref)
      ) ||
      report.tests.cases.some((item) => item.expected !== item.actual) ||
      !isDeepStrictEqual(
        report.tests.cases.map(({ id, stageId, expected }) => ({ id, stageId, expected })),
        projectContractCaseSummaries(bundle, manifest)
      )
    )
      invalid()
    return report
  } catch (cause) {
    if (cause instanceof Error && cause.message === "AUTHORING_VERSION_CHANGED") throw cause
    return invalid()
  }
}

export function createProjectPackageReport(
  bundle: AuthoringSourceBundle,
  manifest: ProjectRuntimeManifest,
  excluded: string[],
  tests: ProjectContractReport
): ProjectPackageReport {
  return parseProjectPackageReport(
    JSON.stringify({
      schemaVersion: 1,
      packageId: manifest.plugin.id,
      version: manifest.plugin.version,
      sourceDigest: bundle.digest,
      files: bundle.files.map((file) => file.path),
      excluded,
      dependencies: manifest.actions.map((action) => action.ref),
      tests,
      install: installHint
    }),
    bundle,
    manifest
  )
}

/** The one known root metadata file is read separately from the author bundle. */
export function readProjectPackageReport(
  root: string,
  bundle: AuthoringSourceBundle,
  manifest?: ProjectRuntimeManifest
): ProjectPackageReportObservation | undefined {
  const file = join(root, PROJECT_PACKAGE_REPORT_PATH)
  if (!existsSync(file)) return undefined
  const rootIdentity = identity(root, true)
  const fileIdentity = identity(file, false)
  const raw = readBoundedAuthoringVersionFile(file, AUTHORING_BUNDLE_LIMITS.fileBytes)
  if (identity(root, true) !== rootIdentity || identity(file, false) !== fileIdentity)
    throw Error("AUTHORING_VERSION_CHANGED")
  return {
    report: parseProjectPackageReport(raw, bundle, manifest),
    sha256: hash(raw),
    rootIdentity,
    fileIdentity
  }
}

export function assertProjectPackageReportUnchanged(
  root: string,
  previous: ProjectPackageReportObservation
) {
  if (
    identity(root, true) !== previous.rootIdentity ||
    identity(join(root, PROJECT_PACKAGE_REPORT_PATH), false) !== previous.fileIdentity
  )
    throw Error("AUTHORING_VERSION_CHANGED")
}

/** Historical excluded strings never decide which present package files may be discarded. */
export function projectPackageActualExcluded(
  excluded: string[],
  report?: ProjectPackageReportObservation
) {
  return report ? excluded.filter((path) => path !== PROJECT_PACKAGE_REPORT_PATH) : excluded
}
