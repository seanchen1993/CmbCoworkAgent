import AdmZip from "adm-zip"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { createAuthoringTemplate } from "./authoring-templates"
import type { AuthoringSourceBundle } from "./authoring-bundle"
import {
  createProjectTemplate,
  type ProjectTemplateInput,
  type ProjectTemplateKind
} from "./project-template"
import { compileProjectHarness } from "./project-harness"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { readProjectSource } from "./project-source"
import { inspectProjectSource } from "./project-doctor"
import { testProjectSource } from "./project-contract"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import { compileFunctionPlugin } from "../v2/loader"
import { readPluginManifest } from "../../plugins/manifest"
import { packageUsesSharedMods } from "../../harness-board/project-runtime/package-preflight"

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
export async function compileProjectPlugin(directory: string, outputDirectory: string) {
  const source = await readProjectSource(directory)
  const bundle = compileProjectHarness(source.bundle)
  const manifest = parseProjectRuntimeManifest(
    JSON.parse(bundle.files.find((file) => file.path === "devclaw.project-runtime.json")!.text)
  )
  const tests = await testProjectSource(bundle, manifest)
  if (!tests.valid) throw Error("PROJECT_HARNESS_CONTRACT_FAILED")
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
  const source = await readProjectSource(directory, resourcePaths)
  guard()
  if (expectedDigest !== undefined && source.bundle.digest !== expectedDigest)
    throw Error("PROJECT_SOURCE_CHANGED")
  const { report, manifest } = inspectProjectSource(
    source.bundle,
    source.excluded,
    availableActions
  )
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
  const packageReport = {
    schemaVersion: 1,
    packageId: manifest.plugin.id,
    version: manifest.plugin.version,
    sourceDigest: source.bundle.digest,
    files: source.bundle.files.map((file) => file.path),
    excluded: source.excluded,
    dependencies: manifest.actions.map((action) => action.ref),
    tests,
    install: "通过原插件页面的 ZIP 安装入口；创建项目时由宿主绑定真实安装 UUID。"
  }
  zip.addFile(
    "devclaw.package-report.json",
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
  const source = await readProjectSource(directory, resourcePaths)
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
