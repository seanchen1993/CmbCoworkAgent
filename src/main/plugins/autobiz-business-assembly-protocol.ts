import { createHash } from "node:crypto"
import { BUSINESS_MOD_ASSEMBLY, BUSINESS_MOD_MANIFEST } from "../../shared/business-mods"
import { businessModPath, parseBusinessModCatalog } from "./business-mod-manifest"
import reviewed from "./autobiz-business-kernel-reviewed.json"
import mergeReviewed from "./autobiz-business-kernel-merge-reviewed.json"
import wakeupReviewed from "./autobiz-business-kernel-wakeup-reviewed.json"
import specRoleReviewed from "./autobiz-business-kernel-spec-role-reviewed.json"
import utestLiteralReviewed from "./autobiz-business-kernel-utest-literal-reviewed.json"
import reviewedWorkflow from "./autobiz-business-routing-reviewed.json"
import { projectBusinessModNodes, projectBusinessModWorkflowRouting } from "./business-mod-workflow"
import {
  projectBusinessModWorkflow,
  type BusinessModWorkflowProjection
} from "./business-mod-workflow-projection"
import {
  EXTENSION_BOARD_API_VERSION,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  parseProjectRuntimeManifest,
  projectRuntimeExtensionContract
} from "../../shared/project-runtime"
import { AUTOBIZ_CONTEXT_OUTPUT } from "../../shared/project-runtime/autobiz-handoff"
import { assertProjectNodeAgentResources } from "./project-agent-resources"

interface Snapshot {
  files: readonly { path: string; bytes: Buffer }[]
}
export interface ReviewedBusinessKernel {
  id: string
  version: string
  inspectCommandsDigest: string
  files: Array<{ path: string; digest: string }>
  modules: Record<string, { definitionDigest: string; files: Record<string, string> }>
}
// Each independently reviewed version pins its complete byte closure. Never accept a profile
// supplied by a plugin or infer trust from a newer version number.
const reviewedKernels: readonly ReviewedBusinessKernel[] = [reviewed, mergeReviewed, wakeupReviewed, specRoleReviewed, utestLiteralReviewed]
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
        )
      : value
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("ASSEMBLY_OBJECT")
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw Error("ASSEMBLY_FIELD")
}
function rows(value: unknown): Array<{ path: string; digest: string }> {
  if (!Array.isArray(value) || value.length > 4096) throw Error("ASSEMBLY_FILES")
  const seen = new Set<string>()
  return value.map((item) => {
    const row = object(item)
    fields(row, ["path", "digest"])
    const path = businessModPath(row.path)
    if (
      seen.has(path.toLowerCase()) ||
      typeof row.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.digest)
    )
      throw Error("ASSEMBLY_FILE")
    seen.add(path.toLowerCase())
    return { path, digest: row.digest }
  })
}
function json(files: Map<string, Buffer>, path: string, limit = 262144) {
  const bytes = files.get(path)
  if (!bytes || bytes.length > limit) throw Error("ASSEMBLY_MANIFEST")
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
}

/** Exact reviewed kernel and original business definitions; author checks stay namespaced.
 * A self-authored lock digest is an integrity check, never sufficient protocol admission.
 */
export function verifyReviewedBusinessAssembly(
  snapshot: Snapshot,
  kernel: ReviewedBusinessKernel
): boolean {
  try {
    const files = new Map(snapshot.files.map((file) => [file.path, file.bytes]))
    if (
      files.size !== snapshot.files.length ||
      snapshot.files.some((file) => /\.(?:pyd|so|dll|pyc|pyo|pyw)$/i.test(file.path))
    )
      return false
    const lock = object(json(files, BUSINESS_MOD_ASSEMBLY, 1024 * 1024))
    fields(lock, [
      "apiVersion",
      "name",
      "version",
      "kernel",
      "sources",
      "mods",
      "extensions",
      "files"
    ])
    if (lock.apiVersion !== "devclaw.business-assembly/v1") return false
    const identity = object(json(files, "plugin.json"))
    if (identity.name !== lock.name || identity.version !== lock.version) return false
    const declaredKernel = object(lock.kernel)
    fields(declaredKernel, ["id", "version", "files"])
    if (declaredKernel.id !== kernel.id || declaredKernel.version !== kernel.version) return false
    const expected = rows(kernel.files),
      actual = rows(declaredKernel.files)
    if (!expected.length || expected.length !== actual.length) return false
    for (const row of expected) {
      const declaration = actual.find((item) => item.path === row.path)
      const bytes = files.get(row.path)
      if (declaration?.digest !== row.digest || !bytes || digest(bytes) !== row.digest) return false
    }
    const inventory = rows(lock.files)
    if (inventory.length !== files.size - 1) return false
    for (const row of inventory) {
      const bytes = files.get(row.path)
      if (row.path === BUSINESS_MOD_ASSEMBLY || !bytes || digest(bytes) !== row.digest) return false
    }
    const catalog = parseBusinessModCatalog(json(files, BUSINESS_MOD_MANIFEST))
    if (
      !catalog.kernel ||
      catalog.kernel.id !== kernel.id ||
      catalog.kernel.version !== kernel.version ||
      catalog.kernel.boardConfigPath !== "board_core/board_config.json"
    )
      return false
    const mods = lock.mods
    if (
      !Array.isArray(mods) ||
      !mods.length ||
      mods.length > 32 ||
      mods.length !== catalog.modules.length
    )
      return false
    const sources = lock.sources
    if (!Array.isArray(sources) || !sources.length || sources.length > 8) return false
    const selected = new Set<string>(),
      allowedPython = new Set(
        expected.filter((row) => row.path.endsWith(".py")).map((row) => row.path)
      )
    const userSkills: string[] = []
    for (const [index, raw] of mods.entries()) {
      const mod = object(raw),
        definition = catalog.modules[index]
      fields(mod, ["id", "nodeId", "sourceDigest"])
      if (
        mod.id !== definition.id ||
        mod.nodeId !== definition.node.id ||
        selected.has(definition.id) ||
        typeof mod.sourceDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(mod.sourceDigest)
      )
        return false
      selected.add(definition.id)
      if (
        !sources.some((raw) => {
          const source = object(raw)
          fields(source, ["name", "digest", "mods"])
          return (
            typeof source.name === "string" &&
            source.name.length <= 256 &&
            source.digest === mod.sourceDigest &&
            Array.isArray(source.mods) &&
            source.mods.includes(mod.id)
          )
        })
      )
        return false
      const original = kernel.modules[definition.id]
      const agentResources = assertProjectNodeAgentResources(definition.node, path => files.get(path))
      if (original) {
        if (digest(JSON.stringify(canonical(definition))) !== original.definitionDigest)
          return false
        for (const path of agentResources) {
          const pins = [
            ...kernel.files.filter(file => file.path === path).map(file => file.digest),
            ...Object.values(kernel.modules).flatMap(module => module.files[path] ? [module.files[path]] : [])
          ]
          if (!pins.length || pins.some(pin => pin !== digest(files.get(path)!))) return false
        }
        for (const [path, expectedDigest] of Object.entries(original.files)) {
          const bytes = files.get(path)
          if (!bytes || digest(bytes) !== expectedDigest) return false
          if (path.endsWith(".py")) allowedPython.add(path)
        }
      } else {
        if (definition.skill.entry !== `skills/${String(definition.node.skill)}/SKILL.md`)
          return false
        if (
          Object.values(kernel.modules).some((original) =>
            Object.keys(original.files).some((path) =>
              path.endsWith(`/${String(definition.node.skill)}/SKILL.md`)
            )
          )
        )
          return false
        const skillRoot = definition.skill.entry.slice(0, -"/SKILL.md".length) + "/"
        if (agentResources.some(path => !path.startsWith(skillRoot) &&
          !path.startsWith(`mods/business/${definition.id}/`))) return false
        userSkills.push(`skills/${String(definition.node.skill)}/`)
      }
    }
    const extensions = lock.extensions ?? []
    const definitions = catalog.extensions ?? []
    if (
      !Array.isArray(extensions) ||
      extensions.length > 32 ||
      extensions.length !== definitions.length
    )
      return false
    for (const [index, raw] of extensions.entries()) {
      const extension = object(raw),
        definition = definitions[index]
      fields(extension, ["id", "sourceDigest"])
      if (
        extension.id !== definition.id ||
        selected.has(definition.id) ||
        typeof extension.sourceDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(extension.sourceDigest)
      )
        return false
      selected.add(definition.id)
      if (
        !sources.some((raw) => {
          const source = object(raw)
          fields(source, ["name", "digest", "mods"])
          return (
            typeof source.name === "string" &&
            source.name.length <= 256 &&
            source.digest === extension.sourceDigest &&
            Array.isArray(source.mods) &&
            source.mods.includes(extension.id)
          )
        })
      )
        return false
      const namespace = `mods/business/${definition.id}/`
      for (const resource of [
        definition.entry,
        ...definition.resources,
        ...(definition.skills ?? [])
      ]) {
        if (
          !resource.startsWith(namespace) ||
          ![...files.keys()].some((path) => path === resource || path.startsWith(resource + "/"))
        )
          return false
      }
    }
    const auxiliarySkillRoots = definitions.flatMap((definition) =>
      (definition.skills ?? []).map((entry) => entry.slice(0, -"/SKILL.md".length))
    )
    if (
      auxiliarySkillRoots.length &&
      JSON.stringify(identity.skills) !== JSON.stringify(["skills", ...auxiliarySkillRoots])
    )
      return false
    if (extensions.length) {
      if (identity.mods !== "mods/manifest.json") return false
      const native = object(json(files, "mods/manifest.json"))
      fields(native, ["apiVersion", "id", "claw"])
      const expectedClaw = {
        componentsVersion: 1,
        actions: definitions.flatMap((definition) => definition.actions ?? []),
        components: definitions.map((definition) => ({
          id: definition.id,
          name: definition.title,
          kind: "module",
          entry: definition.entry.slice("mods/".length),
          dependsOn: definition.dependencies.required.filter((id) =>
            definitions.some((item) => item.id === id)
          ),
          actionIds: (definition.actions ?? []).map((action) => action.id),
          ...(definition.configSchema ? { configSchema: definition.configSchema } : {}),
          usage: definition.usage ?? "project"
        }))
      }
      if (
        native.apiVersion !== "cmb.mods/v2" ||
        native.id !== identity.name ||
        JSON.stringify(canonical(native.claw)) !== JSON.stringify(canonical(expectedClaw))
      )
        return false
    } else if (files.has("mods/manifest.json") || identity.mods !== undefined) return false
    for (const path of files.keys()) {
      if (!path.endsWith(".py") || allowedPython.has(path)) continue
      if (
        ![...selected].some(
          (id) => !kernel.modules[id] && path.startsWith(`mods/business/${id}/`)
        ) &&
        !userSkills.some((prefix) => path.startsWith(prefix))
      )
        return false
    }
    const board = object(json(files, "board_core/board_config.json", 1024 * 1024))
    const runtimeBytes = files.get("devclaw.project-runtime.json")
    if (runtimeBytes) {
      const runtime = json(files, "devclaw.project-runtime.json")
      const contract = projectRuntimeExtensionContract(runtime)
      const manifest = parseProjectRuntimeManifest(runtime)
      if (contract?.verifiedArtifacts) {
        const outputs = catalog.modules.flatMap(mod => {
          const artifacts = object(mod.node.artifacts ?? {})
          return Array.isArray(artifacts.outputs) ? artifacts.outputs.map(object) : []
        })
        if (manifest.mode !== "legacy" || !manifest.artifacts.some(output =>
          output.id === AUTOBIZ_CONTEXT_OUTPUT.id && output.path === AUTOBIZ_CONTEXT_OUTPUT.path && output.required) ||
          contract.verifiedArtifacts.artifactIds.some(id => outputs.filter(output => output.id === id).length !== 1))
          return false
      }
      if (
        manifest.plugin.id !== identity.name ||
        manifest.plugin.version !== identity.version ||
        (contract
          ? !contract.requires.includes(REQUIRED_BUSINESS_CHECKS_PROTOCOL) ||
            board.apiVersion !== EXTENSION_BOARD_API_VERSION
          : board.apiVersion === EXTENSION_BOARD_API_VERSION)
      )
        return false
    } else if (board.apiVersion === EXTENSION_BOARD_API_VERSION) return false
    if (
      !board.inspectCommands ||
      digest(JSON.stringify(canonical(board.inspectCommands))) !== kernel.inspectCommandsDigest
    )
      return false
    const workflow = object(board.workflow)
    fields(workflow, [
      "nodes",
      "templates",
      "profiles",
      "dynamicStages",
      "skipPolicy",
      "checkpoints",
      "transitions"
    ])
    // Existing fixed-flow packages retain their exact admission. New packages add only the
    // deterministic custom template; no mixed/author-defined routing or kernel bytes are allowed.
    const routes: Array<Pick<BusinessModWorkflowProjection, "nodes" | "routing">> = [
      true,
      false
    ].map((custom) => ({
      nodes: projectBusinessModNodes(catalog.modules),
      routing: projectBusinessModWorkflowRouting(catalog.modules, custom)
    }))
    if (
      board.apiVersion === EXTENSION_BOARD_API_VERSION &&
      reviewedKernels.some(
        (profile) => profile.id === kernel.id && profile.version === kernel.version
      )
    ) {
      const projected = projectBusinessModWorkflow(catalog.modules, reviewedWorkflow)
      if (!projected.requiresFixedWorkflowAcknowledgement) routes.push(projected)
    }
    if (
      !routes.some(
        ({ nodes, routing }) =>
          JSON.stringify(canonical(workflow.nodes)) === JSON.stringify(canonical(nodes)) &&
          Object.entries(routing).every(
            ([key, expected]) =>
              JSON.stringify(canonical(workflow[key])) === JSON.stringify(canonical(expected))
          )
      )
    )
      return false
    const skipPolicy = object(workflow.skipPolicy)
    if (
      !Array.isArray(skipPolicy.lockedNodes) ||
      skipPolicy.lockedNodes.length > mods.length ||
      new Set(skipPolicy.lockedNodes).size !== skipPolicy.lockedNodes.length ||
      skipPolicy.lockedNodes.some((id) => !catalog.modules.some((mod) => mod.id === id))
    )
      return false
    return true
  } catch {
    return false
  }
}

export function isReviewedAutobizBusinessAssembly(snapshot: Snapshot): boolean {
  return reviewedKernels.some((profile) => verifyReviewedBusinessAssembly(snapshot, profile))
}
