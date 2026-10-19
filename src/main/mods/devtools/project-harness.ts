import { z } from "zod"
import {
  parseProjectRuntimeManifest,
  preserveProjectRuntimeEnvelope,
  type ProjectRuntimeManifest
} from "../../../shared/project-runtime"
import { createAuthoringSourceBundle, type AuthoringSourceBundle } from "./authoring-bundle"
import { parseSkillNameFromFrontmatterYaml } from "../../skills/frontmatter"
import { validateRegisteredToolInput, validateToolSchema } from "../v2/tool-schema"
import type { ModObject } from "../../../shared/mods/types"
import { clawActionObject } from "../../../shared/mods/claw-actions"
import { assertProjectActionLock } from "../../harness-board/project-runtime/action-input"
import { PROJECT_ACTION_LOCK_PATH } from "../../../shared/project-runtime/action-bindings"

export const HARNESS_SOURCE_PATH = "devclaw.harness.json"
const id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)
const artifact = z
  .object({
    id,
    path: z.string().min(1).max(240),
    // Explicit fixture text avoids pretending to infer a valid instance of arbitrary JSON Schema.
    example: z.string().max(16000),
    schema: z.record(z.string(), z.unknown()).optional()
  })
  .strict()
export const harnessDefinitionSchema = z
  .object({
    apiVersion: z.literal("devclaw.harness/v1"),
    nodes: z
      .array(
        z
          .object({
            id,
            title: z.string().min(1).max(100),
            skill: z.string().regex(/^skills\/[a-zA-Z0-9_-]+\/SKILL\.md$/),
            artifacts: z.array(artifact).min(1).max(8),
            approval: z.enum(["none", "human"]).default("none")
          })
          .strict()
      )
      .min(1)
      .max(8)
  })
  .strict()
export type HarnessDefinition = z.input<typeof harnessDefinitionSchema>
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** Authoring sugar only: the output is the existing production manifest and real contract fixtures. */
export function compileProjectHarness(source: AuthoringSourceBundle): AuthoringSourceBundle {
  const get = (path: string) => source.files.find((file) => file.path === path)?.text
  const parsed = harnessDefinitionSchema.safeParse(JSON.parse(get(HARNESS_SOURCE_PATH) ?? "null"))
  if (!parsed.success) throw Error("PROJECT_HARNESS_INVALID")
  const definition = parsed.data
  const plugin = JSON.parse(get("plugin.json") ?? "null")
  if (!plugin || typeof plugin.name !== "string" || typeof plugin.version !== "string")
    throw Error("PROJECT_PLUGIN_IDENTITY")
  const previous = get("devclaw.project-runtime.json")
  const existing = previous ? parseProjectRuntimeManifest(JSON.parse(previous)) : undefined
  if (existing && (existing.mode !== "host" || existing.plugin.id !== plugin.name))
    throw Error("PROJECT_HARNESS_IDENTITY_CHANGED")
  if (
    existing?.stages.some(
      (stage) => stage.actionIds.length && !definition.nodes.some((node) => node.id === stage.id)
    )
  )
    throw Error("PROJECT_HARNESS_BOUND_NODE_REMOVED")
  const artifacts: ProjectRuntimeManifest["artifacts"] = []
  const checks: ProjectRuntimeManifest["checks"] = []
  const paths = new Set<string>()
  let count = 0
  const cases: Array<{
    id: string
    stageId: string
    files: Array<{ path: string; text: string }>
    expected: "passed" | "failed"
  }> = []
  const stages = definition.nodes.map((node) => {
    const skill = get(node.skill)
    if (!skill || !parseSkillNameFromFrontmatterYaml(skill))
      throw Error("PROJECT_HARNESS_SKILL_MISSING")
    const files = node.artifacts.map((item) => ({ path: item.path, text: item.example }))
    const checkIds = node.artifacts.map((item) => {
      const key = item.path.toLowerCase()
      if (paths.has(key)) throw Error("PROJECT_HARNESS_ARTIFACT_DUPLICATE")
      paths.add(key)
      artifacts.push({ id: item.id, path: item.path, required: true })
      const checkId = `${item.id}-check`
      if (item.schema) {
        validateToolSchema(item.schema as ModObject, { allowReservedKeys: true })
        validateRegisteredToolInput(
          item.schema as ModObject,
          clawActionObject(JSON.parse(item.example))
        )
      }
      checks.push({
        id: checkId,
        artifactId: item.id,
        sideEffect: "read",
        kind: item.schema ? "json-schema" : "file-exists",
        ...(item.schema ? { schema: item.schema } : {})
      })
      cases.push({
        id: `missing-${count++}`,
        stageId: node.id,
        files: files.filter((file) => file.path !== item.path),
        expected: "failed"
      })
      return checkId
    })
    cases.push({ id: `${node.id}-present`, stageId: node.id, files, expected: "passed" })
    return {
      id: node.id,
      title: node.title,
      skill: node.skill,
      artifactIds: node.artifacts.map((item) => item.id),
      checkIds,
      approval: node.approval,
      actionIds: existing?.stages.find((stage) => stage.id === node.id)?.actionIds ?? []
    }
  })
  if (cases.length > 32) throw Error("PROJECT_HARNESS_CONTRACT_LIMIT")
  const manifest = parseProjectRuntimeManifest({
    apiVersion: "devclaw.project-runtime/v1",
    plugin: { id: plugin.name, version: plugin.version },
    mode: "host",
    stateOwner: "host",
    stages,
    artifacts,
    checks,
    actions: existing?.actions ?? [],
    environment: [],
    capabilities: {
      execution: true,
      conditionalTransition: true,
      idempotency: true,
      reconciliation: false,
      cancellation: true
    }
  })
  // The manifest parser rejects traversal and duplicate identifiers; check path prefix aliases too.
  for (const path of paths) {
    if ([...paths].some((other) => other !== path && other.startsWith(`${path}/`)))
      throw Error("PROJECT_HARNESS_ARTIFACT_DUPLICATE")
  }
  if (manifest.actions.length || get(PROJECT_ACTION_LOCK_PATH))
    assertProjectActionLock(manifest, JSON.parse(get(PROJECT_ACTION_LOCK_PATH) ?? "null"))
  return createAuthoringSourceBundle([
    ...source.files.filter(
      (file) => !["devclaw.project-runtime.json", "tests/project-contract.json"].includes(file.path)
    ),
    {
      path: "devclaw.project-runtime.json",
      text: json(
        preserveProjectRuntimeEnvelope(previous ? JSON.parse(previous) : undefined, manifest)
      )
    },
    ...(!get("devclaw.capabilities.json")
      ? [
          {
            path: "devclaw.capabilities.json",
            text: json({
              apiVersion: "devclaw.capabilities/v1",
              capabilities: [
                {
                  id: "project-flow",
                  title: String(plugin.name).slice(0, 128),
                  kind: "flow",
                  usage: "project",
                  entry: "devclaw.project-runtime.json"
                }
              ]
            })
          }
        ]
      : []),
    {
      path: "tests/project-contract.json",
      text: json({ apiVersion: "devclaw.project-contract/v1", cases })
    }
  ])
}
