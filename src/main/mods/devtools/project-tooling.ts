import AdmZip from "adm-zip"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { createAuthoringTemplate } from "./authoring-templates"
import { createAuthoringSourceBundle, type AuthoringSourceBundle } from "./authoring-bundle"
import { compileNativeComposition, NATIVE_COMPOSITION_PATH } from "../../plugins/native-composition"
import {
  createProjectTemplate,
  type ProjectTemplateInput,
  type ProjectTemplateKind
} from "./project-template"
import { compileProjectHarness } from "./project-harness"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { readAuthoringProjectSource, readProjectSource } from "./project-source"
import { inspectProjectSource } from "./project-doctor"
import { assertProjectContractPassed, testProjectSource } from "./project-contract"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import { compileFunctionPlugin } from "../v2/loader"
import { readPluginManifest } from "../../plugins/manifest"
import { packageUsesSharedMods } from "../../harness-board/project-runtime/package-preflight"
import {
  assertProjectPackageReportUnchanged,
  createProjectPackageReport,
  projectPackageActualExcluded,
  PROJECT_PACKAGE_REPORT_PATH,
  readProjectPackageReport
} from "./project-package-report"

async function checkProjectExtensions(directory: string) {
  const metadata = readPluginManifest(directory)?.manifest
  if (metadata && packageUsesSharedMods(directory, metadata)) await compileFunctionPlugin(directory)
}

async function writeNewBundle(directory: string, bundle: AuthoringSourceBundle, guard = () => {}) {
  guard()
  await mkdir(directory, { recursive: false })
  for (const file of bundle.files) {
    guard()
    const target = join(directory, file.path)
    await mkdir(dirname(target), { recursive: true })
    guard()
    await writeFile(target, file.text, { encoding: "utf8", flag: "wx" })
  }
}

export async function initProjectPlugin(
  directory: string,
  options: Omit<ProjectTemplateInput, "template"> & {
    template?: ProjectTemplateKind | "command"
  }
) {
  const bundle =
    options.template === "command"
      ? createAuthoringTemplate({
          id: options.packageId,
          name: options.name,
          instruction: "处理用户提供的文字。",
          kind: "command"
        })
      : createProjectTemplate({ ...options, template: options.template })
  const root = resolve(directory)
  await writeNewBundle(root, bundle)
  return {
    directory: root,
    digest: bundle.digest,
    files: bundle.files.map((file) => file.path),
    executed: false
  }
}

/** Compilation publishes a new directory, never edits an installed or source package in place. */
export async function compileProjectPlugin(
  directory: string,
  outputDirectory: string,
  availableActions: readonly ClawActionDescriptor[] = []
) {
  const source = await readAuthoringProjectSource(directory)
  const native = source.bundle.files.find((file) => file.path === NATIVE_COMPOSITION_PATH)
  if (
    native &&
    source.bundle.files.some(
      (file) => file.path === "devclaw.harness.json" || file.path === "mods/business/manifest.json"
    )
  )
    throw Error("NATIVE_COMPOSITION_MULTIPLE_SOURCES")
  const bundle = native
    ? createAuthoringSourceBundle(
        compileNativeComposition(JSON.parse(native.text), {
          files: source.bundle.files.map((file) => ({
            path: file.path,
            bytes: Buffer.from(file.text)
          })),
          actionCatalog: availableActions
        }).files.map((file) => ({ path: file.path, text: file.bytes.toString("utf8") }))
      )
    : compileProjectHarness(source.bundle)
  const manifest = parseProjectRuntimeManifest(
    JSON.parse(bundle.files.find((file) => file.path === "devclaw.project-runtime.json")!.text)
  )
  const tests = await testProjectSource(bundle, manifest)
  assertProjectContractPassed(tests)
  const output = resolve(outputDirectory)
  await writeNewBundle(output, bundle)
  return {
    directory: output,
    digest: bundle.digest,
    files: bundle.files.map((file) => file.path),
    tests,
    executed: false
  }
}

export async function testProjectPlugin(
  directory: string,
  availableActions: readonly ClawActionDescriptor[] = []
) {
  const source = await readProjectSource(directory)
  const { report, manifest } = inspectProjectSource(
    source.bundle,
    source.excluded,
    availableActions
  )
  if (!report.valid || !manifest) return { valid: false, doctor: report }
  await checkProjectExtensions(source.root)
  return testProjectSource(source.bundle, manifest)
}

/** ZIP uses the ordinary plugin import format. This function does not install or grant permissions. */
export async function packProjectPlugin(
  directory: string,
  outputFile: string,
  expectedDigest?: string,
  guard = () => {},
  availableActions: readonly ClawActionDescriptor[] = [],
  resourcePaths?: readonly string[]
) {
  guard()
  const source = await readAuthoringProjectSource(directory, resourcePaths)
  guard()
  const previousReport = readProjectPackageReport(source.root, source.bundle)
  const excluded = projectPackageActualExcluded(source.excluded, previousReport)
  if (expectedDigest !== undefined && source.bundle.digest !== expectedDigest)
    throw Error("PROJECT_SOURCE_CHANGED")
  const { report, manifest } = inspectProjectSource(source.bundle, excluded, availableActions)
  if (!report.valid || !manifest) throw Error("PROJECT_PACK_DOCTOR_FAILED")
  await checkProjectExtensions(source.root)
  guard()
  const tests = await testProjectSource(source.bundle, manifest)
  guard()
  if (!tests.valid) throw Error("PROJECT_PACK_CONTRACT_FAILED")
  const output = resolve(outputFile)
  if (!output.toLowerCase().endsWith(".zip")) throw Error("PROJECT_PACK_ZIP_REQUIRED")
  const zip = new AdmZip()
  for (const file of source.bundle.files) zip.addFile(file.path, Buffer.from(file.text, "utf8"))
  if (previousReport) {
    assertProjectPackageReportUnchanged(source.root, previousReport)
    const current = readProjectPackageReport(source.root, source.bundle, manifest)
    if (current?.sha256 !== previousReport.sha256) throw Error("PROJECT_SOURCE_CHANGED")
  }
  const packageReport = createProjectPackageReport(source.bundle, manifest, excluded, tests)
  zip.addFile(
    PROJECT_PACKAGE_REPORT_PATH,
    Buffer.from(`${JSON.stringify(packageReport, null, 2)}\n`)
  )
  guard()
  await writeFile(output, zip.toBuffer(), { flag: "wx" })
  return { output, ...packageReport }
}

/** Explicit isolated development preparation. Saving project source never mutates an installed plugin. */
export async function prepareProjectDevelopment(
  directory: string,
  outputDirectory: string,
  expectedDigest?: string,
  guard = () => {},
  availableActions: readonly ClawActionDescriptor[] = [],
  resourcePaths?: readonly string[]
) {
  guard()
  const source = await readAuthoringProjectSource(directory, resourcePaths)
  guard()
  if (expectedDigest !== undefined && source.bundle.digest !== expectedDigest)
    throw Error("PROJECT_SOURCE_CHANGED")
  const { report } = inspectProjectSource(source.bundle, source.excluded, availableActions)
  if (!report.valid) throw Error("PROJECT_DEV_DOCTOR_FAILED")
  const output = resolve(outputDirectory)
  await mkdir(output, { recursive: false })
  const packagePath = join(output, `package-${source.bundle.digest.slice(0, 12)}`)
  await writeNewBundle(packagePath, source.bundle, guard)
  await checkProjectExtensions(packagePath)
  guard()
  const workspace = join(output, "workspace")
  guard()
  await mkdir(workspace)
  return {
    status: "prepared" as const,
    digest: source.bundle.digest,
    packagePath,
    workspace,
    sourceName: basename(source.root),
    executed: false,
    message: "已创建独立源码快照与空工作区；尚未安装、调用模型或执行阶段。"
  }
}
